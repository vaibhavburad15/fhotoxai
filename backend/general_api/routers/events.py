import os
import random
import string
import json
import logging
import qrcode
from fastapi import APIRouter, BackgroundTasks, Depends, Form, HTTPException
from typing import Optional, List

from general_api.auth_utils import assert_event_access, require_roles
from general_api.config import BASE_DIR, FRONTEND_URL, BANNERS_DIR
from general_api.database import execute_query, execute_insert, execute_update, execute_update_safely, get_connection
from general_api.services.notification_service import notification_service
from fastapi.responses import FileResponse
import zipfile
import uuid

logger = logging.getLogger("events_router")

def _cleanup_temp_file(path: str):
    """Delete a temp file after it has been served."""
    import time
    time.sleep(60)
    try:
        if os.path.exists(path):
            os.remove(path)
    except Exception:
        pass

router = APIRouter(prefix="/events", tags=["events"])

@router.get("/")
async def get_events():
    """Get list of all events with photo counts"""
    query = """
    SELECT e.*, 
    (SELECT COUNT(*) FROM photos p WHERE p.event_id = e.id) as photo_count,
    (SELECT COUNT(*) FROM faces f JOIN photos p ON f.photo_id = p.id WHERE p.event_id = e.id) as face_count
    FROM events e
    ORDER BY e.created_at DESC
    """
    events = execute_query(query)
    # Map status to photos_upload_complete for frontend compatibility
    for e in events:
        e['photos_upload_complete'] = 1 if e.get('status') == 'completed' else 0
    return events

@router.post("/create")
async def create_event(
    background_tasks: BackgroundTasks,
    name: str = Form(...),
    date: str = Form(...),
    location: str = Form(...),
    description: Optional[str] = Form(None),
    admin_id: str = Form(...),
    time: Optional[str] = Form(None),
    photography_service: bool = Form(True),
    data_retention: str = Form('3'),
    photographer_ids: Optional[str] = Form(None),
    registration_url_base: Optional[str] = Form(None),
    event_type: str = Form('corporate'),
    owner_email: Optional[str] = Form(None),
    event_size: Optional[str] = Form('1-300'),
    current_user: dict = Depends(require_roles("organizer")),
):
    logger.info(f"Creating event: {name} by user {current_user['id']}")
    try:
        admin_id_int = int(current_user["id"])
        p_ids_int = []
        if photographer_ids and photographer_ids.strip():
            try:
                p_ids_raw = json.loads(photographer_ids)
                p_ids_int = [int(pid) for pid in p_ids_raw] if isinstance(p_ids_raw, list) else [int(p_ids_raw)]
            except:
                p_ids_int = [int(pid.strip()) for pid in photographer_ids.split(',') if pid.strip()]

        # Banner Selection
        banner_path = None
        try:
            folder_name = 'corporate'
            for key in ['wedding', 'birthday', 'corporate']:
                if key in event_type.lower():
                    folder_name = key
                    break
            banners_dir = os.path.join(BANNERS_DIR, folder_name)
            if os.path.exists(banners_dir):
                files = [f for f in os.listdir(banners_dir) if f.lower().endswith(('.png', '.jpg', '.jpeg'))]
                if files:
                    banner_path = f"/banners/{folder_name}/{random.choice(files)}"
        except Exception as e:
            logger.error(f"Banner error: {e}")

        # ID Generation
        prefix = 'oth'
        for k, p in {'birthday': 'brd', 'corporate': 'crp', 'wedding': 'wdg'}.items():
            if k in event_type.lower():
                prefix = p
                break
        event_uuid = f"{prefix} - {''.join(random.choices(string.digits, k=4))}"

        # Insert Event
        primary_p_id = p_ids_int[0] if p_ids_int else None
        query = """
            INSERT INTO events 
            (name, date, location, description, event_time, photography_service, data_retention, event_size, owner_email, photographer_id, created_by, status, banner_path, event_uuid)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 'active', %s, %s)
        """
        params = (name, date, location, description, time, photography_service, data_retention, event_size, owner_email, primary_p_id, admin_id_int, banner_path, event_uuid)
        event_id = execute_insert(query, params)

        # Link Users (use execute_update since these tables have no 'id' column)
        execute_update("INSERT INTO user_events (user_id, event_id, role) VALUES (%s, %s, %s) ON CONFLICT DO NOTHING", (admin_id_int, event_id, 'organizer'))
        for pid in p_ids_int:
            execute_update("INSERT INTO event_photographers (event_id, photographer_id) VALUES (%s, %s) ON CONFLICT DO NOTHING", (event_id, pid))
            execute_update("INSERT INTO user_events (user_id, event_id, role) VALUES (%s, %s, %s) ON CONFLICT DO NOTHING", (pid, event_id, 'photographer'))

        # QR Code
        qr_dir = os.path.join(BASE_DIR, "uploads", "qrcodes")
        os.makedirs(qr_dir, exist_ok=True)
        img = qrcode.make(f"{FRONTEND_URL}/attendee/access?eventId={event_id}")
        qr_path = f"/uploads/qrcodes/event_{event_id}_qr.png"
        with open(os.path.join(BASE_DIR, qr_path.lstrip('/')), "wb") as qr_file:
            img.save(qr_file)
        execute_update_safely("UPDATE events SET qr_code_path = %s WHERE id = %s", (qr_path, event_id))

        # Notify Photographers
        for pid in p_ids_int:
            p_data = execute_query("SELECT email FROM users WHERE id = %s", (pid,))
            if p_data:
                background_tasks.add_task(notification_service.send_photographer_invitation, p_data[0]['email'], name, f"{FRONTEND_URL}/photographer/login")

        # Send Event Creation Confirmation exactly here
        if owner_email:
            background_tasks.add_task(
                notification_service.send_event_creation_confirmation, 
                owner_email, 
                name,
                date,
                time or "",
                location,
                f"{FRONTEND_URL}/organizer/dashboard"
            )

        return {"status": "success", "id": event_id, "event_uuid": event_uuid, "qr_code_path": qr_path, "banner_path": banner_path}

    except Exception as e:
        logger.error(f"Event creation failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/{event_id}")
async def get_event_by_id(event_id: int):
    event = execute_query("SELECT * FROM events WHERE id = %s", (event_id,))
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")
    
    event_data = event[0]
    # Map status to photos_upload_complete for frontend compatibility
    event_data['photos_upload_complete'] = 1 if event_data.get('status') == 'completed' else 0

    # Add stats
    stats = execute_query("""
        SELECT 
            (SELECT COUNT(*) FROM photos WHERE event_id = %s) as photo_count,
            (SELECT COUNT(*) FROM attendees WHERE event_id = %s) as attendee_count
    """, (event_id, event_id))
    
    event_payload = {**event_data, **stats[0]}
    return {"status": "success", "event": event_payload}

@router.delete("/{event_id}")
async def delete_event(
    event_id: int,
    current_user: dict = Depends(require_roles("organizer")),
):
    assert_event_access(current_user, event_id, {"organizer"})
    execute_update("DELETE FROM events WHERE id = %s", (event_id,))
    return {"status": "success", "message": f"Event {event_id} deleted"}

@router.put("/{event_id}/status")
async def update_event_status(
    event_id: int,
    status: str = Form(...),
    current_user: dict = Depends(require_roles("organizer", "photographer")),
):
    """Update event status (active, completed, archived)"""
    assert_event_access(current_user, event_id, {"organizer", "photographer"})
    execute_update("UPDATE events SET status = %s WHERE id = %s", (status, event_id))
    return {"status": "success", "message": f"Event {event_id} status updated to {status}"}

@router.get("/{event_id}/uploads")
async def get_upload_history(
    event_id: int,
    current_user: dict = Depends(require_roles("organizer", "photographer")),
):
    """Get upload history for an event from upload_jobs"""
    assert_event_access(current_user, event_id, {"organizer", "photographer"})
    query = """
        SELECT 
            uj.*,
            a.name AS attendee_name,
            a.email AS attendee_email
        FROM upload_jobs uj
        LEFT JOIN attendees a ON uj.attendee_id = a.id
        WHERE uj.event_id = %s 
        ORDER BY uj.started_at DESC
    """
    results = execute_query(query, (event_id,))
    return {"status": "success", "uploads": results}

@router.get("/{event_id}/download-zip")
async def download_event_zip(
    event_id: int,
    background_tasks: BackgroundTasks,
    current_user: dict = Depends(require_roles("organizer", "photographer")),
):
    """Download all photos for an event as ZIP"""
    assert_event_access(current_user, event_id, {"organizer", "photographer"})
    zip_path = os.path.join(BASE_DIR, "downloads", f"event_{event_id}_{uuid.uuid4()}.zip")
    os.makedirs(os.path.dirname(zip_path), exist_ok=True)
    
    photos = execute_query("SELECT file_path FROM photos WHERE event_id = %s", (event_id,))
    
    with zipfile.ZipFile(zip_path, 'w') as zipf:
        for photo in photos:
            full_path = os.path.join(BASE_DIR, photo['file_path'])
            if os.path.exists(full_path):
                zipf.write(full_path, os.path.basename(full_path))
    
    background_tasks.add_task(_cleanup_temp_file, zip_path)
    return FileResponse(zip_path, filename=f"event_{event_id}.zip")
