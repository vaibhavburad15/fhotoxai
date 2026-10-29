import logging
import random
import secrets
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, Form, HTTPException, Request, Response, status

from general_api.auth_utils import (
    ROLE_DESCRIPTIONS,
    assert_event_access,
    build_username,
    clear_session_cookie,
    create_user_session,
    delete_user_session,
    get_authenticated_user,
    get_request_ip,
    get_session_id_from_request,
    get_user_by_identity,
    hash_password,
    is_bcrypt_hash,
    is_valid_role,
    link_attendees_to_user,
    normalize_role,
    require_roles,
    sanitize_user,
    set_session_cookie,
    verify_password,
)
from general_api.config import FRONTEND_URL
from general_api.database import execute_insert, execute_query, execute_update
from general_api.services.notification_service import notification_service

logger = logging.getLogger("auth_router")

router = APIRouter(prefix="/auth", tags=["auth"])

# Simple in-memory OTP store retained for attendee OTP verification flow.
otp_store = {}


def _user_has_role(user_id: int, role: str) -> bool:
    rows = execute_query(
        """
        SELECT 1
        FROM user_roles ur
        JOIN roles r ON r.id = ur.role_id
        WHERE ur.user_id = %s AND LOWER(r.name) = LOWER(%s)
        LIMIT 1
        """,
        (user_id, role),
    )
    return bool(rows)


def _ensure_attendee_user(email: str, password: Optional[str] = None, name: Optional[str] = None) -> dict:
    existing_user = get_user_by_identity(email)
    role_id = _get_role_id("attendee")
    display_name = name.strip() if name and name.strip() else email.split("@", 1)[0]

    if existing_user:
        execute_update(
            "INSERT INTO user_roles (user_id, role_id) VALUES (%s, %s) ON CONFLICT DO NOTHING",
            (existing_user["id"], role_id),
        )
        if password or name:
            execute_update(
                """
                UPDATE users
                SET password_hash = COALESCE(%s, password_hash),
                    full_name = COALESCE(NULLIF(%s, ''), full_name),
                    is_active = TRUE
                WHERE id = %s
                """,
                (hash_password(password) if password else None, display_name, existing_user["id"]),
            )
        link_attendees_to_user(existing_user["id"], email)
        return get_user_by_identity(email) or existing_user

    user_id = execute_insert(
        """
        INSERT INTO users (username, email, password_hash, full_name, organization, is_active)
        VALUES (%s, %s, %s, %s, %s, TRUE)
        """,
        (
            build_username(email, "attendee"),
            email,
            hash_password(password or secrets.token_urlsafe(32)),
            display_name,
            None,
        ),
    )
    execute_update(
        "INSERT INTO user_roles (user_id, role_id) VALUES (%s, %s) ON CONFLICT DO NOTHING",
        (user_id, role_id),
    )
    link_attendees_to_user(user_id, email)
    return get_user_by_identity(email) or sanitize_user(
        {
            "id": user_id,
            "email": email,
            "full_name": email.split("@", 1)[0],
            "role": "attendee",
            "is_active": True,
        }
    )


def _resolve_event_id(value: Optional[str]) -> Optional[int]:
    return int(value) if value and value.strip().isdigit() else None


def _get_attendee_record(email: str, event_id: Optional[int]) -> Optional[dict]:
    if event_id is not None:
        attendee_rows = execute_query(
            """
            SELECT id, event_id
            FROM attendees
            WHERE LOWER(email) = LOWER(%s) AND event_id = %s
            ORDER BY id DESC
            LIMIT 1
            """,
            (email, event_id),
        )
    else:
        attendee_rows = execute_query(
            """
            SELECT id, event_id
            FROM attendees
            WHERE LOWER(email) = LOWER(%s)
            ORDER BY id DESC
            LIMIT 1
            """,
            (email,),
        )

    return attendee_rows[0] if attendee_rows else None


def _create_attendee_session_response(
    request: Request,
    response: Response,
    attendee_user: dict,
    email: str,
    event_id: Optional[int],
    message: str,
) -> dict:
    attendee_row = _get_attendee_record(email, event_id)
    attendee_id = attendee_row["id"] if attendee_row else None
    attendee_event_id = attendee_row["event_id"] if attendee_row else event_id

    session_id = create_user_session(
        user_id=attendee_user["id"],
        user_agent=request.headers.get("user-agent"),
        ip_address=get_request_ip(request),
    )
    set_session_cookie(response, session_id)

    return {
        "status": "success",
        "message": message,
        "attendee_id": attendee_id,
        "event_id": attendee_event_id,
        "verified": True,
        "is_registered": attendee_id is not None,
        "requires_registration": attendee_id is None,
        "next_step": "welcome" if attendee_id is not None else "registration",
        "session_id": session_id,
        "user": sanitize_user(attendee_user),
    }


def _get_role_id(role: str) -> int:
    rows = execute_query("SELECT id FROM roles WHERE name = %s", (role,))
    if rows:
        return rows[0]["id"]

    return execute_insert(
        "INSERT INTO roles (name, description) VALUES (%s, %s)",
        (role, ROLE_DESCRIPTIONS.get(role, role.title())),
    )


def _normalize_email(value: str) -> str:
    return value.strip().lower()


def _validate_signup_request(request: Request, role: str, password: str, name: str) -> None:
    if not name.strip():
        raise HTTPException(status_code=400, detail="Name is required.")

    if len(password) < 8:
        raise HTTPException(status_code=400, detail="Password must be at least 8 characters long.")

    if not is_valid_role(role):
        raise HTTPException(status_code=400, detail="Invalid role.")

    if role == "admin":
        requester = getattr(request.state, "user", None)
        if not requester or normalize_role(requester.get("role")) != "admin":
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Admin accounts can only be created by an authenticated admin.",
            )


@router.post("/send-otp")
async def send_otp(email: str = Form(...), event_id: str = Form(...)):
    """Send OTP to email with robust error handling."""
    email = _normalize_email(email)
    otp = str(random.randint(100000, 999999))
    otp_store[email] = otp

    logger.info("Generated OTP for %s", email)

    success = notification_service.send_otp_email(email, otp)
    if success:
        return {"status": "success", "message": f"OTP sent to {email}"}

    logger.warning("Failed to send email to %s, but stored OTP for demo mode.", email)
    return {"status": "success", "message": "OTP generated (Demo Mode)", "otp_hint": otp}


@router.post("/verify-otp")
async def verify_otp(
    request: Request,
    response: Response,
    email: str = Form(...),
    otp: str = Form(...),
    event_id: Optional[str] = Form(None),
):
    """Verify provided OTP."""
    email = _normalize_email(email)
    otp = otp.strip()

    logger.info("Verifying OTP for %s", email)

    if email in otp_store and otp_store[email] == otp:
        attendee_user = _ensure_attendee_user(email)
        result = _create_attendee_session_response(
            request=request,
            response=response,
            attendee_user=attendee_user,
            email=email,
            event_id=_resolve_event_id(event_id),
            message="OTP verified successfully",
        )
        otp_store.pop(email, None)
        return result

    raise HTTPException(status_code=401, detail="Invalid OTP")


@router.post("/attendee-login")
async def attendee_login(
    request: Request,
    response: Response,
    email: str = Form(...),
    password: str = Form(...),
    event_id: Optional[str] = Form(None),
):
    identity = _normalize_email(email)
    attendee_user = get_user_by_identity(identity)

    if not attendee_user:
        raise HTTPException(status_code=401, detail="Invalid email or password.")

    if not _user_has_role(attendee_user["id"], "attendee"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This email belongs to a staff account. Use the matching staff portal.",
        )

    if not verify_password(password, attendee_user.get("password_hash", "")):
        raise HTTPException(status_code=401, detail="Invalid email or password.")

    if not attendee_user.get("is_active", True):
        raise HTTPException(status_code=403, detail="This account is inactive.")

    if not is_bcrypt_hash(attendee_user.get("password_hash")):
        execute_update(
            "UPDATE users SET password_hash = %s WHERE id = %s",
            (hash_password(password), attendee_user["id"]),
        )
        attendee_user = get_user_by_identity(identity) or attendee_user

    return _create_attendee_session_response(
        request=request,
        response=response,
        attendee_user=attendee_user,
        email=identity,
        event_id=_resolve_event_id(event_id),
        message="Login successful.",
    )


@router.post("/attendee-signup")
async def attendee_signup(
    request: Request,
    response: Response,
    name: str = Form(...),
    email: str = Form(...),
    password: str = Form(...),
    otp: str = Form(...),
    event_id: Optional[str] = Form(None),
):
    email = _normalize_email(email)
    otp = otp.strip()
    name = name.strip()

    if not name:
        raise HTTPException(status_code=400, detail="Name is required.")

    if len(password) < 8:
        raise HTTPException(status_code=400, detail="Password must be at least 8 characters long.")

    if email not in otp_store or otp_store[email] != otp:
        raise HTTPException(status_code=401, detail="Invalid OTP")

    attendee_user = _ensure_attendee_user(email, password=password, name=name)
    result = _create_attendee_session_response(
        request=request,
        response=response,
        attendee_user=attendee_user,
        email=email,
        event_id=_resolve_event_id(event_id),
        message="Signup successful.",
    )
    otp_store.pop(email, None)
    return result


@router.post("/verify-attendee")
async def verify_attendee_status(email: str = Form(...), event_id: Optional[str] = Form(None)):
    """Verify if an email is already registered as an attendee."""
    email = _normalize_email(email)

    logger.info("Direct verification check for email %s (event_id: %s)", email, event_id)

    if event_id:
        query = "SELECT id, event_id FROM attendees WHERE email = %s AND event_id = %s"
        attendee = execute_query(query, (email, event_id))
    else:
        query = "SELECT id, event_id FROM attendees WHERE email = %s ORDER BY id DESC LIMIT 1"
        attendee = execute_query(query, (email,))

    if attendee:
        return {
            "status": "success",
            "message": "Attendee verified",
            "attendee_id": attendee[0]["id"],
            "event_id": attendee[0]["event_id"],
            "verified": True,
        }

    raise HTTPException(status_code=404, detail="Attendee not found")


@router.post("/signup")
@router.post("/register")
async def signup(
    request: Request,
    name: str = Form(...),
    email: str = Form(...),
    password: str = Form(...),
    role: str = Form("organizer"),
    organization: Optional[str] = Form(None),
):
    email = _normalize_email(email)
    role = normalize_role(role)

    _validate_signup_request(request, role, password, name)

    existing_user = execute_query("SELECT id FROM users WHERE LOWER(email) = LOWER(%s)", (email,))
    if existing_user:
        raise HTTPException(status_code=400, detail="Email already registered.")

    username = build_username(email, role)
    password_hash = hash_password(password)

    try:
        user_id = execute_insert(
            """
            INSERT INTO users (username, email, password_hash, full_name, organization, is_active)
            VALUES (%s, %s, %s, %s, %s, TRUE)
            """,
            (username, email, password_hash, name.strip(), organization),
        )
        role_id = _get_role_id(role)
        execute_update(
            "INSERT INTO user_roles (user_id, role_id) VALUES (%s, %s) ON CONFLICT DO NOTHING",
            (user_id, role_id),
        )
        if role == "attendee":
            link_attendees_to_user(user_id, email)
    except Exception as exc:
        if "duplicate key value" in str(exc).lower():
            raise HTTPException(status_code=400, detail="Email already registered.") from exc
        raise HTTPException(status_code=500, detail="Failed to create user.") from exc

    created_user = get_user_by_identity(email)
    return {
        "status": "success",
        "message": "Signup successful.",
        "user_id": user_id,
        "user": sanitize_user(created_user or {"id": user_id, "email": email, "full_name": name, "role": role}),
    }


@router.post("/login")
async def login(
    request: Request,
    response: Response,
    email: str = Form(...),
    password: str = Form(...),
):
    identity = _normalize_email(email)
    user = get_user_by_identity(identity)

    if not user or not verify_password(password, user.get("password_hash", "")):
        raise HTTPException(status_code=401, detail="Invalid email or password.")

    if not user.get("is_active", True):
        raise HTTPException(status_code=403, detail="This account is inactive.")

    if not is_bcrypt_hash(user.get("password_hash")):
        execute_update(
            "UPDATE users SET password_hash = %s WHERE id = %s",
            (hash_password(password), user["id"]),
        )

    session_id = create_user_session(
        user_id=user["id"],
        user_agent=request.headers.get("user-agent"),
        ip_address=get_request_ip(request),
    )
    set_session_cookie(response, session_id)

    return {
        "status": "success",
        "message": "Login successful.",
        "session_id": session_id,
        "user": sanitize_user(user),
    }


@router.post("/logout")
async def logout(
    request: Request,
    response: Response,
    current_user: dict = Depends(get_authenticated_user),
):
    session_id = getattr(request.state, "session_id", None) or get_session_id_from_request(request)
    if session_id:
        delete_user_session(session_id)

    clear_session_cookie(response)
    return {
        "status": "success",
        "message": f"Logged out {current_user.get('email')}.",
    }


@router.post("/send-invitations")
async def send_invitations(
    background_tasks: BackgroundTasks,
    emails: str = Form(...),
    event_id: int = Form(...),
    current_user: dict = Depends(require_roles("organizer")),
):
    """
    Send invitations to a list of emails for a specific event.
    """
    assert_event_access(current_user, event_id, {"organizer"})

    event = execute_query("SELECT name, qr_code_path FROM events WHERE id = %s", (event_id,))
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")

    event_data = event[0]
    event_name = event_data["name"]
    qr_code_path = event_data.get("qr_code_path")

    email_list = [item.strip() for item in emails.split(",") if item.strip()]
    count = 0

    for email_address in email_list:
        background_tasks.add_task(
            notification_service.send_guest_invitation,
            email_address,
            event_name,
            event_id,
            FRONTEND_URL,
            qr_code_path or "",
        )
        count += 1

    logger.info("Queued %s invitations for event %s", count, event_id)
    return {"status": "success", "message": f"{count} invitations queued for sending"}
