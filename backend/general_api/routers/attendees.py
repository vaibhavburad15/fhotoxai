import os
import logging
from datetime import datetime
from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, HTTPException, UploadFile
from typing import Optional, List
from fastapi.responses import FileResponse
import zipfile
import uuid
import numpy as np
import cv2
from general_api.auth_utils import (
    assert_attendee_access,
    require_roles,
)
from general_api.config import BASE_DIR, FRONTEND_URL, UPLOADS_DIR
from general_api.database import execute_query, execute_insert, execute_update, execute_many
from general_api.services.face_service import face_service
from general_api.services.s3_service import upload_file_to_s3

logger = logging.getLogger("attendees_router")
ATTENDEE_MATCH_THRESHOLD = float(os.getenv("ATTENDEE_MATCH_THRESHOLD", "0.40"))

def _cleanup_temp_file(path: str):
    """Delete a temp file after it has been served."""
    import time
    time.sleep(60)
    try:
        if os.path.exists(path):
            os.remove(path)
    except Exception:
        pass

router = APIRouter(prefix="/attendees", tags=["attendees"])


def _normalize_photo_path(path: Optional[str]) -> Optional[str]:
    if not path:
        return path
    return path.replace("\\", "/")


def _write_local_file(path: str, content: bytes) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as output_file:
        output_file.write(content)


def _get_matched_photos(cluster_id: Optional[int], event_id: Optional[int]) -> List[dict]:
    """Distinct photos containing the attendee's face cluster, newest first."""
    if not cluster_id:
        return []
    rows = execute_query(
        """
        SELECT p.id AS photo_id, p.file_path AS photo_url, p.storage_type
        FROM photos p
        WHERE EXISTS (
            SELECT 1 FROM faces f
            WHERE f.photo_id = p.id AND f.person_cluster_id = %s
        )
          AND (%s IS NULL OR p.event_id = %s)
        ORDER BY p.upload_date DESC, p.id DESC
        """,
        (cluster_id, event_id, event_id),
    )
    return [
        {
            "id": row["photo_id"],
            "photo_id": row["photo_id"],
            "photo_url": _normalize_photo_path(row["photo_url"]),
            "storage_type": row.get("storage_type") or "local",
        }
        for row in rows or []
    ]


def _assert_photo_download_access(current_user: dict, photo_ids: List[int]) -> None:
    if current_user.get("role") == "admin":
        return

    unique_photo_ids = list(dict.fromkeys(photo_ids))
    if not unique_photo_ids:
        raise HTTPException(status_code=400, detail="photo_ids are required.")

    # Attendees may download photos they uploaded or photos their face was matched in.
    placeholders = ", ".join(["%s"] * len(unique_photo_ids))
    query = f"""
        SELECT DISTINCT p.id
        FROM photos p
        JOIN users u ON u.id = %s
        JOIN attendees a ON (
              a.user_id = u.id
              OR (
                  a.user_id IS NULL
                  AND a.email IS NOT NULL
                  AND LOWER(a.email) = LOWER(u.email)
              )
          )
        WHERE p.id IN ({placeholders})
          AND (
              p.attendee_id = a.id
              OR (
                  a.cluster_id IS NOT NULL
                  AND p.event_id = a.event_id
                  AND EXISTS (
                      SELECT 1 FROM faces f
                      WHERE f.photo_id = p.id AND f.person_cluster_id = a.cluster_id
                  )
              )
          )
    """
    rows = execute_query(query, (current_user["id"], *unique_photo_ids))
    owned_ids = {row["id"] for row in rows}
    if owned_ids != set(unique_photo_ids):
        raise HTTPException(status_code=403, detail="You can only download your own photos.")


def _resolve_attendee_cluster(attendee_id: int) -> Optional[int]:
    """Resolve attendee cluster from embedding if cluster_id is still NULL after processing."""
    rows = execute_query(
        """
        SELECT id, event_id, cluster_id, face_embedding
        FROM attendees
        WHERE id = %s
        LIMIT 1
        """,
        (attendee_id,),
    )
    if not rows:
        return None

    attendee = rows[0]
    if attendee.get("cluster_id") is not None:
        return attendee["cluster_id"]

    embedding = attendee.get("face_embedding")
    event_id = attendee.get("event_id")
    if embedding is None or event_id is None:
        return None

    nearest = execute_query(
        """
        SELECT id, (1.0 - (centroid <=> %s)) AS similarity
        FROM people_clusters
        WHERE event_id = %s AND centroid IS NOT NULL
        ORDER BY centroid <=> %s ASC
        LIMIT 1
        """,
        (embedding, event_id, embedding),
    )
    if not nearest:
        return None

    cluster_id = nearest[0]["id"]
    similarity = float(nearest[0].get("similarity") or 0.0)
    if similarity < ATTENDEE_MATCH_THRESHOLD:
        logger.info(
            "Attendee %s unmatched after clustering: best similarity %.4f below threshold %.2f",
            attendee_id,
            similarity,
            ATTENDEE_MATCH_THRESHOLD,
        )
        return None

    execute_update("UPDATE attendees SET cluster_id = %s WHERE id = %s", (cluster_id, attendee_id))
    logger.info(
        "Resolved cluster for attendee %s -> cluster %s (similarity=%.4f)",
        attendee_id,
        cluster_id,
        similarity,
    )
    return cluster_id

# ==========================================
# FACE REGISTRATION ENDPOINT
# ==========================================

@router.post("/register-face")
async def register_face(
    event_id: int = Form(...),
    name: str = Form(...),
    email: str = Form(...),
    phone: Optional[str] = Form(None),
    selfie: UploadFile = File(...),
    current_user: dict = Depends(require_roles("attendee")),
):
    """Register an attendee with biometric data (face embedding stored via pgvector)"""
    try:
        normalized_email = email.strip().lower()
        if current_user.get("email", "").strip().lower() != normalized_email:
            raise HTTPException(
                status_code=403,
                detail="Registration email must match your verified attendee session.",
            )

        contents = await selfie.read()
        nparr = np.frombuffer(contents, np.uint8)
        img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        if img is None:
            raise HTTPException(status_code=400, detail="Invalid image")
        
        if not face_service.load_models():
            raise HTTPException(status_code=500, detail="Models failed to load")
            
        face_record = face_service.get_embedding(img)
        if face_record is None:
            raise HTTPException(status_code=400, detail="No face detected")
        
        embedding = face_record['embedding']
        # L2-normalize embedding for consistent cosine similarity matching
        embedding = embedding / (np.linalg.norm(embedding) + 1e-10)

        # Store embedding directly in PostgreSQL via pgvector
        attendee_user_id = current_user["id"]
        query = """
            INSERT INTO attendees (event_id, user_id, name, email, phone, face_embedding, consent)
            VALUES (%s, %s, %s, %s, %s, %s, TRUE)
            RETURNING id
        """
        attendee_id = execute_insert(query, (event_id, attendee_user_id, name, normalized_email, phone, embedding))
        
        # Send Registration Email
        try:
            import subprocess
            
            event_res = execute_query("SELECT name FROM events WHERE id = %s", (event_id,))
            event_name = event_res[0]['name'] if event_res else "Event"
            
            login_url = f"{FRONTEND_URL}/attendee/access?email={normalized_email}&eventId={event_id}"
            script_path = os.path.join(BASE_DIR, "ai_api", "attendee_registration_email.js")
            
            subprocess.Popen([
                "node", 
                script_path, 
                normalized_email,
                name, 
                event_name, 
                login_url
            ], cwd=BASE_DIR)
            
        except Exception as e:
            logger.error(f"Failed to trigger registration email: {e}")

        return {"status": "success", "id": attendee_id, "message": "Registered successfully"}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Attendee registration failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/{attendee_id}")
async def get_attendee_details(
    attendee_id: int,
    current_user: dict = Depends(require_roles("attendee")),
):
    """Get attendee details by ID with event status"""
    assert_attendee_access(current_user, attendee_id)
    query = """
        SELECT a.*, e.status as event_status, e.name as event_name 
        FROM attendees a 
        JOIN events e ON a.event_id = e.id 
        WHERE a.id = %s
    """
    results = execute_query(query, (attendee_id,))
    if not results:
        raise HTTPException(status_code=404, detail="Attendee not found")
        
    attendee = dict(results[0])
    # Remove un-serializable vector columns
    attendee.pop('face_embedding', None)
    attendee.pop('face_embedding_path', None)
    
    return {"status": "success", "attendee": attendee}


@router.get("/my/events")
async def get_my_events(
    current_user: dict = Depends(require_roles("attendee")),
):
    """Get attendee-registered events plus full event catalog for dashboard flow."""
    try:
        normalized_email = (current_user.get("email") or "").strip().lower()
        user_id = current_user.get("id")

        registered_rows = execute_query(
            """
            SELECT DISTINCT ON (a.event_id)
                a.id AS attendee_id,
                a.event_id,
                a.name AS attendee_name,
                a.cluster_id,
                a.created_at AS registered_at,
                e.name AS event_name,
                e.date AS event_date,
                e.location,
                e.status AS event_status
            FROM attendees a
            JOIN events e ON e.id = a.event_id
            WHERE (
                a.user_id = %s
                OR (
                    a.user_id IS NULL
                    AND a.email IS NOT NULL
                    AND LOWER(a.email) = %s
                )
            )
            ORDER BY a.event_id, a.created_at DESC, a.id DESC
            """,
            (user_id, normalized_email),
        )

        registered_events = []
        registered_event_ids = set()
        for row in registered_rows:
            attendee_id = row["attendee_id"]
            event_id = row["event_id"]
            cluster_id = row.get("cluster_id") or _resolve_attendee_cluster(attendee_id)

            matched_photos = 0
            if cluster_id:
                matched_rows = execute_query(
                    """
                    SELECT COUNT(DISTINCT p.id) AS count
                    FROM faces f
                    JOIN photos p ON p.id = f.photo_id
                    WHERE f.person_cluster_id = %s
                      AND p.event_id = %s
                    """,
                    (cluster_id, event_id),
                )
                matched_photos = int(matched_rows[0]["count"]) if matched_rows else 0

            total_rows = execute_query(
                "SELECT COUNT(*) AS count FROM photos WHERE event_id = %s",
                (event_id,),
            )
            total_event_photos = int(total_rows[0]["count"]) if total_rows else 0

            registered_events.append(
                {
                    "attendee_id": attendee_id,
                    "event_id": event_id,
                    "attendee_name": row.get("attendee_name"),
                    "event_name": row.get("event_name"),
                    "event_date": row.get("event_date"),
                    "location": row.get("location"),
                    "event_status": row.get("event_status") or "active",
                    "registered_at": row.get("registered_at"),
                    "cluster_id": cluster_id,
                    "matched_photos": matched_photos,
                    "total_event_photos": total_event_photos,
                    "can_view_gallery": (row.get("event_status") or "").lower() == "completed",
                }
            )
            registered_event_ids.add(event_id)

        all_event_rows = execute_query(
            """
            SELECT id, name, date, location, status
            FROM events
            ORDER BY created_at DESC
            """
        )

        event_registration_map = {event["event_id"]: event for event in registered_events}

        all_events = []
        for row in all_event_rows:
            event_id = row["id"]
            registered_event = event_registration_map.get(event_id)
            all_events.append(
                {
                    "event_id": event_id,
                    "event_name": row.get("name"),
                    "event_date": row.get("date"),
                    "location": row.get("location"),
                    "event_status": row.get("status") or "active",
                    "is_registered": event_id in registered_event_ids,
                    "attendee_id": registered_event.get("attendee_id") if registered_event else None,
                    "matched_photos": registered_event.get("matched_photos", 0) if registered_event else 0,
                    "total_event_photos": registered_event.get("total_event_photos", 0) if registered_event else 0,
                }
            )

        active_events = []
        for row in all_events:
            if str(row.get("event_status") or "").lower() != "active":
                continue
            active_events.append(
                {
                    "event_id": row["event_id"],
                    "event_name": row.get("event_name"),
                    "event_date": row.get("event_date"),
                    "location": row.get("location"),
                    "event_status": row.get("event_status") or "active",
                    "is_registered": row.get("is_registered", False),
                    "attendee_id": row.get("attendee_id"),
                }
            )

        return {
            "status": "success",
            "registered_events": registered_events,
            "all_events": all_events,
            "active_events": active_events,
            "user": {
                "id": user_id,
                "email": current_user.get("email"),
                "full_name": current_user.get("full_name"),
            },
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error fetching attendee events: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/{attendee_id}/photos")
async def get_attendee_photos(
    attendee_id: int,
    event_id: Optional[int] = None,
    current_user: dict = Depends(require_roles("attendee")),
):
    """Get only the photos the attendee's face was matched in (linked cluster)"""
    try:
        assert_attendee_access(current_user, attendee_id, event_id)
        attendee = execute_query("SELECT cluster_id, event_id FROM attendees WHERE id = %s", (attendee_id,))
        if not attendee:
            raise HTTPException(status_code=404, detail="Attendee not found")

        attendee_event_id = attendee[0].get('event_id')
        effective_event_id = event_id if event_id is not None else attendee_event_id
        cluster_id = attendee[0].get('cluster_id') or _resolve_attendee_cluster(attendee_id)
        faces = _get_matched_photos(cluster_id, effective_event_id)

        return {
            "status": "success",
            "faces": faces,
            "total": len(faces),
            "matched": cluster_id is not None,
            "event_id": effective_event_id,
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error fetching attendee photos: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/{attendee_id}/highlight-reel")
async def get_attendee_highlight_reel(
    attendee_id: int,
    event_id: Optional[int] = None,
    limit: int = 15,
    current_user: dict = Depends(require_roles("attendee")),
):
    """Get the highest quality photos of the attendee for a highlight reel"""
    try:
        assert_attendee_access(current_user, attendee_id, event_id)
        attendee = execute_query("SELECT cluster_id, event_id FROM attendees WHERE id = %s", (attendee_id,))
        if not attendee:
            raise HTTPException(status_code=404, detail="Attendee not found")

        attendee_event_id = attendee[0].get('event_id')
        effective_event_id = event_id if event_id is not None else attendee_event_id
        cluster_id = attendee[0].get('cluster_id') or _resolve_attendee_cluster(attendee_id)
        faces = []

        if cluster_id:
            # Best face per photo, so a photo appears at most once in the reel.
            query = """
                SELECT photo_id, photo_url, storage_type, quality_score
                FROM (
                    SELECT DISTINCT ON (p.id)
                        p.id AS photo_id, p.file_path AS photo_url, p.storage_type, f.quality_score
                    FROM faces f
                    JOIN photos p ON f.photo_id = p.id
                    WHERE f.person_cluster_id = %s
                      AND (%s IS NULL OR p.event_id = %s)
                    ORDER BY p.id, f.quality_score DESC NULLS LAST
                ) best
                ORDER BY quality_score DESC NULLS LAST
                LIMIT %s
            """
            results = execute_query(query, (cluster_id, effective_event_id, effective_event_id, limit))
            for row in results:
                faces.append({
                    "id": row["photo_id"],
                    "photo_id": row["photo_id"],
                    "photo_url": _normalize_photo_path(row["photo_url"]),
                    "storage_type": row.get("storage_type") or "local",
                    "quality_score": row.get("quality_score")
                })
        
        return {"status": "success", "faces": faces, "total": len(faces)}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error fetching attendee highlight reel: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/{attendee_id}/co-attendees")
async def get_co_attendees(
    attendee_id: int,
    current_user: dict = Depends(require_roles("attendee"))
):
    """Get a list of other people (clusters) that appear in the same photos as this attendee"""
    try:
        assert_attendee_access(current_user, attendee_id)
        attendee = execute_query("SELECT cluster_id, event_id FROM attendees WHERE id = %s", (attendee_id,))
        if not attendee:
            raise HTTPException(status_code=404, detail="Attendee not found")

        cluster_id = attendee[0].get('cluster_id') or _resolve_attendee_cluster(attendee_id)
        if not cluster_id:
            return {"status": "success", "co_attendees": []}

        # Find other clusters in the same photos
        query = """
            SELECT DISTINCT c.id as cluster_id, c.cluster_name, p.file_path as thumbnail_url, p.storage_type
            FROM faces f1
            JOIN faces f2 ON f1.photo_id = f2.photo_id AND f1.person_cluster_id != f2.person_cluster_id
            JOIN people_clusters c ON f2.person_cluster_id = c.id
            LEFT JOIN photos p ON c.thumbnail_photo_id = p.id
            WHERE f1.person_cluster_id = %s
        """
        results = execute_query(query, (cluster_id,))
        co_attendees = []
        for row in results:
            # check if this cluster corresponds to a known attendee
            att_query = "SELECT name FROM attendees WHERE cluster_id = %s LIMIT 1"
            att_res = execute_query(att_query, (row["cluster_id"],))
            display_name = att_res[0]["name"] if att_res else row.get("cluster_name") or f"Person {row['cluster_id']}"
            
            co_attendees.append({
                "cluster_id": row["cluster_id"],
                "name": display_name,
                "thumbnail_url": _normalize_photo_path(row.get("thumbnail_url")),
                "storage_type": row.get("storage_type") or "local"
            })

        return {"status": "success", "co_attendees": co_attendees}
    except Exception as e:
        logger.error(f"Error fetching co-attendees: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/{attendee_id}/photos-with/{other_cluster_id}")
async def get_photos_with(
    attendee_id: int,
    other_cluster_id: int,
    current_user: dict = Depends(require_roles("attendee"))
):
    """Get photos where this attendee appears with a specific other person"""
    try:
        assert_attendee_access(current_user, attendee_id)
        attendee = execute_query("SELECT cluster_id, event_id FROM attendees WHERE id = %s", (attendee_id,))
        if not attendee:
            raise HTTPException(status_code=404, detail="Attendee not found")

        cluster_id = attendee[0].get('cluster_id') or _resolve_attendee_cluster(attendee_id)
        if not cluster_id:
            return {"status": "success", "faces": []}

        query = """
            SELECT p.id AS photo_id, p.file_path AS photo_url, p.storage_type
            FROM photos p
            WHERE p.event_id = %s
              AND EXISTS (SELECT 1 FROM faces f WHERE f.photo_id = p.id AND f.person_cluster_id = %s)
              AND EXISTS (SELECT 1 FROM faces f WHERE f.photo_id = p.id AND f.person_cluster_id = %s)
            ORDER BY p.upload_date DESC, p.id DESC
        """
        results = execute_query(query, (attendee[0].get('event_id'), cluster_id, other_cluster_id))
        faces = []
        for row in results:
            faces.append({
                "id": row["photo_id"],
                "photo_id": row["photo_id"],
                "photo_url": _normalize_photo_path(row["photo_url"]),
                "storage_type": row.get("storage_type") or "local"
            })
            
        return {"status": "success", "faces": faces, "total": len(faces)}
    except Exception as e:
        logger.error(f"Error fetching photos with co-attendee: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/photos/download-zip")
async def download_attendee_photos_zip(
    photo_ids: List[int],
    background_tasks: BackgroundTasks,
    filename: str = "photos",
    current_user: dict = Depends(require_roles("attendee")),
):
    """Download selected photos as ZIP"""
    _assert_photo_download_access(current_user, photo_ids)
    zip_path = os.path.join(BASE_DIR, "downloads", f"{filename}_{uuid.uuid4()}.zip")
    os.makedirs(os.path.dirname(zip_path), exist_ok=True)
    
    with zipfile.ZipFile(zip_path, 'w') as zipf:
        for pid in photo_ids:
            photo = execute_query("SELECT file_path FROM photos WHERE id = %s", (pid,))
            if photo:
                full_path = os.path.join(BASE_DIR, photo[0]['file_path'])
                if os.path.exists(full_path):
                    zipf.write(full_path, os.path.basename(full_path))
    
    background_tasks.add_task(_cleanup_temp_file, zip_path)
    return FileResponse(zip_path, filename=f"{filename}.zip")

@router.post("/{attendee_id}/upload")
async def upload_attendee_photos(
    attendee_id: int,
    event_id: Optional[int] = Form(None),
    files: List[UploadFile] = File(...),
    current_user: dict = Depends(require_roles("attendee")),
):
    """Upload photos from an attendee"""
    try:
        attendee_record = assert_attendee_access(current_user, attendee_id, event_id)
        if event_id is None:
            event_id = attendee_record['event_id']

        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        folder_name = f"attendee_{attendee_id}_{timestamp}"
        
        upload_job_id = execute_insert(
            "INSERT INTO upload_jobs (event_id, attendee_id, folder_name, status, total_photos, started_at) VALUES (%s, %s, %s, %s, %s, %s) RETURNING id",
            (event_id, attendee_id, folder_name, 'in_progress', len(files), datetime.now())
        ) 

        event_path = os.path.join(UPLOADS_DIR, f"event_{event_id}", "attendee_uploads", folder_name)
        os.makedirs(event_path, exist_ok=True)

        import io

        uploaded_count = 0
        failed_count = 0
        photo_data_batch = []
        bucket_name = os.environ.get('AWS_S3_BUCKET_NAME', 'photo-cluster-frontend')
        
        for file in files:
            try:
                ext = os.path.splitext(file.filename or "")[1].lower()
                if ext not in ['.jpg', '.jpeg', '.png', '.webp']:
                    failed_count += 1
                    continue
                
                unique_name = f"{uuid.uuid4()}{ext}"
                s3_key = f"uploads/{event_id}/{folder_name}/{unique_name}"
                local_file_path = os.path.join(event_path, unique_name)
                local_relative_path = os.path.relpath(local_file_path, BASE_DIR).replace("\\", "/")
                
                content = await file.read()
                size = len(content)

                storage_type = "local"
                stored_path = local_relative_path

                file_obj = io.BytesIO(content)
                success = upload_file_to_s3(file_obj, bucket_name, s3_key, file.content_type)
                if success:
                    storage_type = "s3"
                    stored_path = s3_key
                else:
                    logger.warning(f"S3 upload failed for {file.filename}; storing locally instead")
                    _write_local_file(local_file_path, content)
                
                photo_data_batch.append((
                    event_id, 
                    stored_path,
                    storage_type,
                    file.filename, 
                    file.content_type or 'image/jpeg', 
                    size, 
                    datetime.now(),
                    attendee_id
                ))
                uploaded_count += 1
            except Exception as e:
                logger.error(f"Failed to save {file.filename}: {e}")
                failed_count += 1
            finally:
                await file.close()
        
        logger.info(photo_data_batch)
        if photo_data_batch:
            execute_many(
                "INSERT INTO photos (event_id, user_id, file_path, storage_type, original_filename, mime_type, file_size, upload_date, attendee_id) VALUES (%s, NULL, %s, %s, %s, %s, %s, %s, %s)",
                photo_data_batch
            )

        if uploaded_count == 0:
            status = 'failed'
            message = "No photos could be uploaded. Please try again."
        elif failed_count == 0:
            status = 'completed'
            message = f"Uploaded {uploaded_count} photo(s) successfully."
        else:
            status = 'completed_with_errors'
            message = f"Uploaded {uploaded_count} photo(s). {failed_count} failed."

        execute_update(
            "UPDATE upload_jobs SET status = %s, progress = 100, photos_processed = %s, photos_uploaded = %s, photos_failed = %s, completed_at = %s WHERE id = %s",
            (status, len(files), uploaded_count, failed_count, datetime.now(), upload_job_id)
        )

        if uploaded_count == 0:
            raise HTTPException(status_code=500, detail=message)
        
        return {
            "status": "success", 
            "uploaded": uploaded_count, 
            "failed": failed_count, 
            "job_id": upload_job_id,
            "message": message
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Attendee upload failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))
