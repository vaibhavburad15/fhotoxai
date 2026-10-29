import os
import uuid
import shutil
import logging
import asyncio
from datetime import datetime
from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, HTTPException, UploadFile
from typing import List, Optional

from general_api.auth_utils import assert_event_access, assert_same_user_or_admin, require_roles
from general_api.config import BASE_DIR, UPLOADS_DIR
from general_api.database import execute_query, execute_insert, execute_update, execute_many
from general_api.services.notification_service import notification_service
from general_api.services.s3_service import upload_file_to_s3, delete_folder_from_s3

logger = logging.getLogger("photos_router")

router = APIRouter(prefix="/photos", tags=["photos"])


def _write_local_file(path: str, content: bytes) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as output_file:
        output_file.write(content)

@router.post("/upload-folder")
async def upload_folder(
    files: List[UploadFile] = File(...),
    folder_name: str = Form(...),
    event_id: str = Form(...),
    photographer_id: str = Form(...),
    current_user: dict = Depends(require_roles("photographer")),
):
    """Upload a folder of photos with progress tracking"""
    assert_same_user_or_admin(current_user, int(photographer_id))
    assert_event_access(current_user, int(event_id), {"photographer"})
    logger.info(f"Uploading {len(files)} files to folder {folder_name}")
    
    upload_job_id = execute_insert(
        "INSERT INTO upload_jobs (event_id, photographer_id, folder_name, status, total_photos, started_at) VALUES (%s, %s, %s, %s, %s, %s)",
        (int(event_id), int(photographer_id), folder_name, 'in_progress', len(files), datetime.now())
    )

    event_path = os.path.join(UPLOADS_DIR, f"event_{event_id}", folder_name)
    os.makedirs(event_path, exist_ok=True)

    uploaded_count = 0
    failed_count = 0
    results = []

    batch_size = 50
    photo_data_batch = []
    import io
    bucket_name = os.environ.get('AWS_S3_BUCKET_NAME', 'photo-cluster-frontend')
    
    for i, file in enumerate(files):
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
            
            # Add to batch
            photo_data_batch.append((
                int(event_id), 
                int(photographer_id), 
                stored_path,
                storage_type,
                file.filename, 
                file.content_type or 'image/jpeg', 
                size, 
                datetime.now()
            ))
            
            uploaded_count += 1
            results.append({"filename": file.filename, "path": stored_path, "storage_type": storage_type})

            # Process batch if full
            if len(photo_data_batch) >= batch_size:
                execute_many(
                    "INSERT INTO photos (event_id, user_id, file_path, storage_type, original_filename, mime_type, file_size, upload_date) VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
                    photo_data_batch
                )
                photo_data_batch = [] # Reset batch
                
                # Update progress
                progress = int(( (uploaded_count + failed_count) / len(files)) * 100)
                execute_update("UPDATE upload_jobs SET photos_processed = %s, photos_uploaded = %s, progress = %s WHERE id = %s", 
                            (uploaded_count + failed_count, uploaded_count, progress, upload_job_id))

        except Exception as e:
            logger.error(f"Upload error for {file.filename}: {e}")
            failed_count += 1
        finally:
            await file.close()

    # Process remaining items in batch
    if photo_data_batch:
        execute_many(
            "INSERT INTO photos (event_id, user_id, file_path, storage_type, original_filename, mime_type, file_size, upload_date) VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
            photo_data_batch
        )

    # Finalize job stats to ensure they are correct even for small batches
    # Using len(results) as it's the most reliable count of successfully processed items
    final_uploaded = len(results)
    final_processed = final_uploaded + failed_count
    if final_uploaded == 0:
        final_status = 'failed'
        message = "No photos could be uploaded. Please try again."
    elif failed_count == 0:
        final_status = 'completed'
        message = f"Uploaded {final_uploaded} photo(s) successfully."
    else:
        final_status = 'completed_with_errors'
        message = f"Uploaded {final_uploaded} photo(s). {failed_count} failed."
    
    logger.info(f"Finalizing Job {upload_job_id}: {final_uploaded} uploaded, {failed_count} failed")
    
    execute_update(
        "UPDATE upload_jobs SET status = %s, completed_at = %s, photos_processed = %s, photos_uploaded = %s, photos_failed = %s, progress = 100 WHERE id = %s",
        (final_status, datetime.now(), final_processed, final_uploaded, failed_count, upload_job_id)
    )

    if final_uploaded == 0:
        raise HTTPException(status_code=500, detail=message)
    
    # Notify Organizer
    try:
        event_data = execute_query(
            "SELECT e.name, u.email as organizer_email, (SELECT full_name FROM users WHERE id = %s) as photographer_name "
            "FROM events e JOIN users u ON e.created_by = u.id WHERE e.id = %s",
            (int(photographer_id), int(event_id))
        )
        if event_data:
            notification_service.send_organizer_upload_complete(
                event_data[0]['organizer_email'],
                event_data[0]['name'],
                event_data[0]['photographer_name'] or "Photographer",
                "https://events.digitalnexusai.com/organizer/dashboard"
            )
    except Exception as e:
        logger.error(f"Failed to trigger organizer notification: {e}")

    return {"status": "success", "uploaded": final_uploaded, "failed": failed_count, "job_id": upload_job_id, "message": message}

@router.get("/folders")
async def get_folders(
    event_id: Optional[int] = None,
    current_user: dict = Depends(require_roles("organizer", "photographer")),
):
    """Get list of photo folders for an event"""
    if event_id is None:
        raise HTTPException(status_code=400, detail="event_id is required.")

    assert_event_access(current_user, event_id, {"organizer", "photographer"})
    # Simplified logic based on DB photos grouped by path prefix or similar
    # In the original app, it scans directories or queries upload_jobs
    # Filter out attendee uploads (folders starting with attendee_)
    query = "SELECT DISTINCT folder_name FROM upload_jobs WHERE event_id = %s AND folder_name NOT LIKE 'attendee_%'"
    folders = execute_query(query, (event_id,))
    return folders

@router.get("/folders/{folder_name}/photos")
async def get_folder_photos(
    folder_name: str,
    event_id: int,
    current_user: dict = Depends(require_roles("organizer", "photographer")),
):
    """Get all photos in a specific folder for an event"""
    assert_event_access(current_user, event_id, {"organizer", "photographer"})
    # Using a more permissive LIKE pattern to handle both / and \
    # We look for the folder name as a directory component
    query = """
        SELECT * FROM photos 
        WHERE event_id = %s 
        AND (file_path LIKE %s OR file_path LIKE %s OR file_path LIKE %s)
    """
    # Patterns: /folder/, \folder\, or starting with folder/ (less likely but safe)
    params = (event_id, f"%%/{folder_name}/%%", f"%%\\{folder_name}\\%%", f"%%{folder_name}/%%")
    results = execute_query(query, params)
    
    # Final fallback: just match the string anywhere in the path for this event
    if not results:
        query = "SELECT * FROM photos WHERE event_id = %s AND file_path LIKE %s"
        params = (event_id, f"%%{folder_name}%%")
        results = execute_query(query, params)
        
    return results
@router.get("/event")
async def list_event_photos(
    event_id: int,
    limit: int = 60,
    offset: int = 0,
    current_user: dict = Depends(require_roles("organizer", "photographer")),
):
    """List an event's photos, newest first, with the total count."""
    assert_event_access(current_user, event_id, {"organizer", "photographer"})
    limit = max(1, min(int(limit), 200))
    offset = max(0, int(offset))
    rows = execute_query(
        """
        SELECT id, file_path, storage_type, original_filename, file_size, upload_date
        FROM photos
        WHERE event_id = %s
        ORDER BY upload_date DESC, id DESC
        LIMIT %s OFFSET %s
        """,
        (event_id, limit, offset),
    )
    total_rows = execute_query(
        "SELECT COUNT(*) AS total FROM photos WHERE event_id = %s", (event_id,)
    )
    return {
        "event_id": event_id,
        "total": total_rows[0]["total"] if total_rows else 0,
        "photos": [
            {
                "id": r["id"],
                "file_path": (r.get("file_path") or "").replace("\\", "/"),
                "storage_type": r.get("storage_type") or "local",
                "original_filename": r.get("original_filename"),
                "file_size": r.get("file_size") or 0,
                "upload_date": r.get("upload_date"),
            }
            for r in (rows or [])
        ],
    }

@router.delete("/folders/{folder_name}")
async def delete_folder(
    folder_name: str,
    event_id: int,
    current_user: dict = Depends(require_roles("organizer", "photographer")),
):
    """Delete a folder of photos from filesystem and database"""
    assert_event_access(current_user, event_id, {"organizer", "photographer"})
    logger.info(f"Deleting folder {folder_name} for event {event_id}")
    
    # 1. Get all photos in this folder
    query = """
        SELECT id, file_path, storage_type FROM photos 
        WHERE event_id = %s 
        AND (file_path LIKE %s OR file_path LIKE %s)
    """
    params = (event_id, f"%%/{folder_name}/%%", f"%%\\{folder_name}\\%%")
    photos = execute_query(query, params)
    
    if not photos:
        # Fallback search
        query = "SELECT id, file_path, storage_type FROM photos WHERE event_id = %s AND file_path LIKE %s"
        params = (event_id, f"%%{folder_name}%%")
        photos = execute_query(query, params)
    
    if not photos:
        # Check if there's an empty upload job at least
        execute_update("DELETE FROM upload_jobs WHERE event_id = %s AND folder_name = %s", (event_id, folder_name))
        return {"status": "success", "message": "No photos found, job record removed if existed"}

    # 2. Delete files from disk or S3
    deleted_count = 0
    s3_folder_deleted = False
    bucket_name = os.environ.get('AWS_S3_BUCKET_NAME', 'photo-cluster-frontend')
    
    for photo in photos:
        rel_path = photo['file_path']
        storage_type = (photo.get('storage_type') or '').lower()
        if storage_type == 's3':
            if not s3_folder_deleted:
                prefix = f"uploads/{event_id}/{folder_name}/"
                delete_folder_from_s3(bucket_name, prefix)
                s3_folder_deleted = True
            deleted_count += 1
        else:
            abs_path = os.path.join(BASE_DIR, rel_path)
            try:
                if os.path.exists(abs_path):
                    os.remove(abs_path)
                    deleted_count += 1
            except Exception as e:
                logger.error(f"Failed to delete file {abs_path}: {e}")

    # 3. Clean up the directory if it's empty
    event_folder_path = os.path.join(UPLOADS_DIR, f"event_{event_id}", folder_name)
    try:
        if os.path.exists(event_folder_path) and not os.listdir(event_folder_path):
            os.rmdir(event_folder_path)
    except Exception as e:
        logger.error(f"Failed to remove directory {event_folder_path}: {e}")

    # 4. Delete entries from database
    photo_ids = [p['id'] for p in photos]
    if photo_ids:
        # Using a simple loop or IN clause. execute_update handles one query.
        # Better to use many or format a string for IN
        id_placeholders = ', '.join(['%s'] * len(photo_ids))
        execute_update(f"DELETE FROM photos WHERE id IN ({id_placeholders})", tuple(photo_ids))

    # 5. Delete from upload_jobs
    execute_update("DELETE FROM upload_jobs WHERE event_id = %s AND folder_name = %s", (event_id, folder_name))

    return {"status": "success", "deleted_files": deleted_count, "db_records": len(photo_ids)}
