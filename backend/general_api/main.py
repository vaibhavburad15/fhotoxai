from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
import logging
import os
import sys
import uvicorn

# Add parent directory (backend/) to sys.path for shared imports
backend_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if backend_dir not in sys.path:
    sys.path.insert(0, backend_dir)

# Disable albumentations version check to prevent timeout warnings
os.environ['ALBUMENTATIONS_DISABLE_VERSION_CHECK'] = '1'

from general_api.routers import auth, events, photos, organizer, photographer
from general_api.routers import attendees as general_attendees
from general_api.routers import clustering as general_clustering
from general_api.auth_utils import SessionAuthMiddleware, ensure_auth_schema
from config import API_TITLE, API_VERSION, UPLOADS_DIR, DOWNLOADS_DIR, BANNERS_DIR, FRONTEND_URL

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger("general_api")

app = FastAPI(
    title=f"{API_TITLE} - General",
    version=API_VERSION,
    description="General Purpose API for Event Management (Port 3001)"
)

# Session authentication
app.add_middleware(SessionAuthMiddleware)

# CORS
configured_origins = {
    FRONTEND_URL.rstrip("/"),
    "http://localhost:5173",
    "http://127.0.0.1:5173",
}
extra_cors_origins = os.getenv("CORS_ORIGINS", "")
for origin in extra_cors_origins.split(","):
    if origin.strip():
        configured_origins.add(origin.strip().rstrip("/"))

app.add_middleware(
    CORSMiddleware,
    allow_origins=sorted(configured_origins),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.on_event("startup")
def startup_db_migration():
    from general_api.database import execute_query, execute_update_safely, execute_update
    try:
        # First, ensure base schema is loaded since docker-entrypoint might not be fast enough
        def _table_exists(table: str) -> bool:
            rows = execute_query(
                "SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = %s",
                (table,)
            )
            return bool(rows)

        if not _table_exists('events') or not _table_exists('photos'):
            logger.info("Base tables missing. Loading schema.sql directly...")
            schema_path = os.path.join(backend_dir, "commons", "schema.sql")
            if os.path.exists(schema_path):
                with open(schema_path, 'r') as f:
                    schema_sql = f.read()
                
                # Split schema by semicolons to execute statements individually, minimizing errors on extensions
                statements = [s.strip() for s in schema_sql.split(';') if s.strip()]
                for stmt in statements:
                    try:
                        execute_update_safely(stmt)
                    except Exception as e:
                        # Some statements like CREATE EXTENSION might fail if already exists or lacks permissions, ignore.
                        pass
                logger.info("Schema loaded successfully from commons/schema.sql")
            else:
                logger.error(f"Schema file not found at {schema_path}")

        # PostgreSQL: check columns via information_schema
        def _column_exists(table: str, column: str) -> bool:
            rows = execute_query(
                "SELECT 1 FROM information_schema.columns WHERE table_name = %s AND column_name = %s",
                (table, column)
            )
            return bool(rows)

        # Events table migrations
        if _table_exists('events'):
            if not _column_exists('events', 'event_size'):
                logger.info("event_size column missing. Adding it...")
                execute_update_safely("ALTER TABLE events ADD COLUMN event_size VARCHAR(50) DEFAULT '1-300'")
                logger.info("Successfully added event_size column.")

            if not _column_exists('events', 'owner_email'):
                logger.info("owner_email column missing. Adding it...")
                execute_update_safely("ALTER TABLE events ADD COLUMN owner_email VARCHAR(255)")
                logger.info("Successfully added owner_email column.")

        # Photos table
        if _table_exists('photos'):
            if not _column_exists('photos', 'storage_type'):
                logger.info("storage_type column missing in photos. Adding it...")
                execute_update_safely("ALTER TABLE photos ADD COLUMN storage_type VARCHAR(20) DEFAULT 'local'")
                logger.info("Successfully added storage_type to photos.")

            if not _column_exists('photos', 'attendee_id'):
                logger.info("attendee_id column missing in photos. Adding it...")
                execute_update_safely("ALTER TABLE photos ADD COLUMN attendee_id INTEGER")
                execute_update_safely("CREATE INDEX IF NOT EXISTS idx_photos_attendee_id ON photos(attendee_id)")
                logger.info("Successfully added attendee_id to photos.")

        # Upload_jobs table
        if _table_exists('upload_jobs'):
            if not _column_exists('upload_jobs', 'attendee_id'):
                logger.info("attendee_id column missing in upload_jobs. Adding it...")
                execute_update_safely("ALTER TABLE upload_jobs ADD COLUMN attendee_id INTEGER")
                execute_update_safely("CREATE INDEX IF NOT EXISTS idx_upload_jobs_attendee_id ON upload_jobs(attendee_id)")
                logger.info("Successfully added attendee_id to upload_jobs.")

        ensure_auth_schema()
        logger.info("Schema checks completed.")
    except Exception as e:
        logger.error(f"Auto-migration failed: {e}")

# Include Routers
app.include_router(auth.router)
app.include_router(events.router)
app.include_router(photos.router)
app.include_router(general_attendees.router)
app.include_router(general_clustering.router)
app.include_router(organizer.router)
app.include_router(photographer.router)


@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    logger.error(f"Global exception: {str(exc)}", exc_info=True)
    return JSONResponse(
        status_code=500,
        content={"message": "Internal server error", "detail": str(exc)}
    )

@app.get("/")
async def root():
    return {"message": "General API is running", "version": API_VERSION, "port": 3001}

# Mount Static Files
class CORSStaticFiles(StaticFiles):
    async def get_response(self, path: str, scope):
        response = await super().get_response(path, scope)
        response.headers["Access-Control-Allow-Origin"] = "*"
        return response

app.mount("/uploads", CORSStaticFiles(directory=UPLOADS_DIR, html=True), name="uploads")
app.mount("/downloads", CORSStaticFiles(directory=DOWNLOADS_DIR, html=True), name="downloads")
if os.path.exists(BANNERS_DIR):
    app.mount("/banners", CORSStaticFiles(directory=BANNERS_DIR, html=True), name="banners")

if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=3001, reload=True)
