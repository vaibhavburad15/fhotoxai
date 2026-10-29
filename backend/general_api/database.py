"""
Database connection and utilities for Photo Clustering API
Connects to PostgreSQL database with pgvector support
"""

import os
import numpy as np
import psycopg2
import psycopg2.pool
import psycopg2.extras
from dotenv import load_dotenv
from typing import Optional, List, Dict, Any
import logging

# Load environment variables from db/.env
project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
env_path = os.path.join(project_root, 'db', '.env')
load_dotenv(env_path)
# Also load from project root .env
load_dotenv(os.path.join(project_root, '.env'))

logger = logging.getLogger(__name__)

# Database configuration
DB_CONFIG = {
    'host': os.getenv('DB_HOST', 'localhost'),
    'port': int(os.getenv('DB_PORT', 5432)),
    'user': os.getenv('DB_USER', 'postgres'),
    'password': os.getenv('DB_PASSWORD', 'postgres'),
    'dbname': os.getenv('DB_NAME', 'digitalnexusai_emc_db'),
}

# -------------------------------------------------------------------
# pgvector adapter: transparently convert between numpy arrays and
# PostgreSQL vector columns.
# -------------------------------------------------------------------
try:
    from pgvector.psycopg2 import register_vector
    _PGVECTOR_AVAILABLE = True
except ImportError:
    _PGVECTOR_AVAILABLE = False
    logger.warning("pgvector Python package not installed. Vector operations will be unavailable. Install with: pip install pgvector")


def _adapt_numpy(arr):
    """Convert numpy array to a string PostgreSQL can understand as a vector literal."""
    if isinstance(arr, np.ndarray):
        return psycopg2.extensions.AsIs("'[" + ",".join(str(float(x)) for x in arr.flatten()) + "]'::vector")
    return arr


# Register the numpy adapter globally so that execute_* helpers
# transparently send numpy arrays as vector literals.
psycopg2.extensions.register_adapter(np.ndarray, _adapt_numpy)

# Create connection pool with retry logic (for Docker startup)
import time

connection_pool = None
_MAX_RETRIES = 10
_RETRY_DELAY = 2  # seconds

for _attempt in range(1, _MAX_RETRIES + 1):
    try:
        connection_pool = psycopg2.pool.ThreadedConnectionPool(
            minconn=2,
            maxconn=32,
            **DB_CONFIG
        )
        logger.info(f"PostgreSQL connection pool created for {DB_CONFIG['dbname']}")
        break
    except psycopg2.Error as err:
        if _attempt < _MAX_RETRIES:
            logger.warning(f"DB connection attempt {_attempt}/{_MAX_RETRIES} failed: {err}. Retrying in {_RETRY_DELAY}s...")
            time.sleep(_RETRY_DELAY)
        else:
            logger.error(f"Failed to create connection pool after {_MAX_RETRIES} attempts: {err}")
            connection_pool = None


def get_connection():
    """Get a connection from the pool"""
    if connection_pool:
        try:
            conn = connection_pool.getconn()
            conn.autocommit = True
            return conn
        except psycopg2.Error as err:
            logger.error(f"Error getting connection: {err}")
            raise
    else:
        raise Exception("Database connection pool not initialized")


def _return_connection(conn):
    """Return a connection to the pool"""
    if connection_pool and conn:
        try:
            connection_pool.putconn(conn)
        except Exception:
            pass


def test_connection() -> bool:
    """Test database connection"""
    conn = None
    try:
        conn = get_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT 1")
        cursor.fetchone()
        cursor.close()
        logger.info("Database connection test successful")
        return True
    except Exception as e:
        logger.error(f"Database connection test failed: {e}")
        return False
    finally:
        _return_connection(conn)


def _register_pgvector(conn):
    """Register pgvector type on a connection if available."""
    if _PGVECTOR_AVAILABLE:
        try:
            register_vector(conn)
        except Exception:
            pass  # extension may not be installed in this DB yet


def execute_query(query: str, params: tuple = None) -> List[Dict[str, Any]]:
    """
    Execute a SELECT query and return results as list of dictionaries
    """
    conn = None
    cursor = None
    try:
        conn = get_connection()
        _register_pgvector(conn)
        cursor = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cursor.execute(query, params or ())
        results = [dict(row) for row in cursor.fetchall()]
        return results
    except psycopg2.Error as err:
        logger.error(f"Query execution error: {err}")
        raise
    finally:
        if cursor:
            cursor.close()
        _return_connection(conn)


def execute_insert(query: str, params: tuple = None) -> int:
    """
    Execute an INSERT query and return the last inserted ID when available.
    If RETURNING is missing, it is appended automatically for inserts that are
    expected to create a row with an ``id`` column.
    """
    conn = None
    cursor = None
    try:
        conn = get_connection()
        _register_pgvector(conn)
        q = query.rstrip().rstrip(';')
        q_lower = q.lower()

        # Join tables often use ON CONFLICT DO NOTHING and have no id column.
        # In those cases we should not auto-append RETURNING id.
        should_append_returning = 'returning' not in q_lower and 'on conflict do nothing' not in q_lower
        if should_append_returning:
            q += ' RETURNING id'

        cursor = conn.cursor()
        cursor.execute(q, params or ())

        if cursor.description:
            row = cursor.fetchone()
            last_id = row[0] if row else None
        else:
            last_id = cursor.rowcount

        conn.commit()
        return last_id
    except psycopg2.Error as err:
        logger.error(f"Insert execution error: {err}")
        if conn:
            conn.rollback()
        raise
    finally:
        if cursor:
            cursor.close()
        _return_connection(conn)


def execute_update(query: str, params: tuple = None) -> int:
    """
    Execute an UPDATE/DELETE query and return affected rows
    """
    conn = None
    cursor = None
    try:
        conn = get_connection()
        _register_pgvector(conn)
        cursor = conn.cursor()
        cursor.execute(query, params or ())
        affected = cursor.rowcount
        conn.commit()
        return affected
    except psycopg2.Error as err:
        logger.error(f"Update execution error: {err}")
        if conn:
            conn.rollback()
        raise
    finally:
        if cursor:
            cursor.close()
        _return_connection(conn)


def execute_many(query: str, params_list: List[tuple]) -> int:
    """
    Execute a query multiple times with different parameters (bulk insert).
    Uses psycopg2.extras.execute_batch for efficiency.
    """
    conn = None
    cursor = None
    try:
        conn = get_connection()
        _register_pgvector(conn)
        cursor = conn.cursor()
        psycopg2.extras.execute_batch(cursor, query, params_list)
        affected = cursor.rowcount
        conn.commit()
        return affected
    except psycopg2.Error as err:
        logger.error(f"Bulk execution error: {err}")
        if conn:
            conn.rollback()
        raise
    finally:
        if cursor:
            cursor.close()
        _return_connection(conn)


class DatabaseTransaction:
    """Context manager for database transactions"""

    def __init__(self):
        self.conn = None
        self.cursor = None

    def __enter__(self):
        self.conn = get_connection()
        self.conn.autocommit = False
        _register_pgvector(self.conn)
        self.cursor = self.conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        return self.cursor

    def __exit__(self, exc_type, exc_val, exc_tb):
        if exc_type is not None:
            self.conn.rollback()
            logger.error(f"Transaction rolled back due to error: {exc_val}")
        else:
            self.conn.commit()

        if self.cursor:
            self.cursor.close()
        _return_connection(self.conn)

        return False  # Don't suppress exceptions


def execute_query_safely(query: str, params: tuple = None) -> Optional[List[Dict[str, Any]]]:
    """Execute query with internal error handling"""
    try:
        return execute_query(query, params)
    except Exception as e:
        logger.error(f"Safe query execution error: {e}")
        return None


def execute_update_safely(query: str, params: tuple = None) -> int:
    """Execute update with internal error handling"""
    try:
        return execute_update(query, params)
    except Exception as e:
        logger.error(f"Safe update execution error: {e}")
        return 0


# Test connection on module load
if connection_pool:
    test_connection()
