/**
 * API Service Layer for Event Photography System
 * Connects frontend to split backend APIs:
 *   - General API (port 3001) via /api proxy
 *   - AI Processing API (port 5001) via /ai-api proxy
 */

const normalizeBase = (value, fallback) => (value || fallback).replace(/\/+$/, '');

export const API_BASE = normalizeBase(import.meta.env.VITE_API_URL, '/api');
const AI_API_BASE = normalizeBase(import.meta.env.VITE_AI_API_URL, '/ai-api');
export const AUTH_EXPIRED_EVENT = 'app:auth-expired';

export const clearStoredAuth = () => {
    try {
        localStorage.removeItem('organizer_user');
        localStorage.removeItem('photographer_user');
    } catch (_) {
        // Ignore storage access issues in non-browser contexts.
    }
};

export const isUnauthorizedError = (error) => Number(error?.status) === 401;

const createApiError = (message, status, detail = null) => {
    const error = new Error(message);
    error.name = 'ApiError';
    error.status = status;
    error.detail = detail;
    return error;
};

const shouldHandleAuthExpiry = (endpoint) => {
    const ignoredEndpoints = [
        '/auth/login',
        '/auth/verify-otp',
        '/auth/attendee-login',
        '/auth/attendee-signup',
    ];
    return !ignoredEndpoints.some((ignored) => endpoint.startsWith(ignored));
};

const broadcastAuthExpiry = (message) => {
    if (typeof window === 'undefined') {
        return;
    }

    clearStoredAuth();
    window.dispatchEvent(new CustomEvent(AUTH_EXPIRED_EVENT, {
        detail: {
            message: message || 'Your session expired. Please log in again.',
        },
    }));
};

const parseJsonResponse = (text) => {
    if (!text) return null;
    try {
        return JSON.parse(text);
    } catch (_) {
        return null;
    }
};

const getUploadMessage = (result, fallback = 'Upload failed') => {
    if (!result || typeof result !== 'object') {
        return fallback;
    }

    const explicitMessage = result.detail || result.message;
    if (typeof explicitMessage === 'string' && explicitMessage.trim()) {
        return explicitMessage;
    }

    const uploaded = Number(result.uploaded ?? 0);
    const failed = Number(result.failed ?? 0);

    if (uploaded > 0 && failed > 0) {
        return `Uploaded ${uploaded} photo(s). ${failed} failed.`;
    }

    if (uploaded > 0) {
        return `Uploaded ${uploaded} photo(s) successfully.`;
    }

    if (failed > 0) {
        return `No photos were uploaded. ${failed} file(s) failed.`;
    }

    return fallback;
};

const ensureUploadSucceeded = (result, fallback = 'Upload failed') => {
    if (!result || typeof result !== 'object') {
        throw new Error(fallback);
    }

    if (result.status && result.status !== 'success') {
        throw new Error(getUploadMessage(result, fallback));
    }

    const uploaded = Number(result.uploaded ?? 0);
    if (uploaded <= 0) {
        throw new Error(getUploadMessage(result, fallback));
    }

    return result;
};

// Helper function for API calls
async function apiCall(endpoint, options = {}, base = API_BASE) {
    const url = `${base}${endpoint}`;
    const config = {
        credentials: options.credentials ?? 'include',
        ...options,
        headers: {
            ...options.headers,
        },
    };

    // Don't set Content-Type for FormData (browser sets it automatically with boundary)
    if (!(options.body instanceof FormData)) {
        config.headers['Content-Type'] = 'application/json';
    }

    // Prevent caching for API calls
    config.cache = 'no-store';

    try {
        const response = await fetch(url, config);

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            // FastAPI puts error details in 'detail' field, standard APIs often use 'message'
            let errorMessage = errorData.detail || errorData.message || `API Error: ${response.status}`;
            if (typeof errorMessage === 'object') {
                errorMessage = JSON.stringify(errorMessage);
            }
            const error = createApiError(errorMessage, response.status, errorData);
            if (response.status === 401 && shouldHandleAuthExpiry(endpoint)) {
                broadcastAuthExpiry(errorMessage);
            }
            throw error;
        }

        return await response.json();
    } catch (error) {
        console.error(`API call failed: ${url}`, error);
        throw error;
    }
}

// ==========================================
// EVENT APIs
// ==========================================

export const eventAPI = {
    /**
     * Create a new event
     */
    create: async (eventData) => {
        // Get the logged-in user's ID from localStorage
        const userStr = localStorage.getItem('organizer_user');
        if (!userStr) {
            throw new Error('User not authenticated. Please log in to create an event.');
        }

        let userId;
        try {
            const user = JSON.parse(userStr);
            userId = user.id;
            if (!userId) {
                throw new Error('User ID not found in session data.');
            }
        } catch (error) {
            throw new Error('Invalid user session. Please log in again.');
        }

        const formData = new FormData();
        formData.append('name', eventData.name || '');
        formData.append('date', eventData.date || '');
        formData.append('location', eventData.facility || eventData.location || '');
        formData.append('time', eventData.time || '');
        formData.append('admin_id', userId.toString()); // Use actual logged-in user ID
        formData.append('description', `${eventData.type || 'Event'} - Contact: ${eventData.owner_name || ''} (${eventData.owner_email || ''})`);
        formData.append('photography_service', eventData.photography_service ? 'true' : 'false');
        formData.append('data_retention', eventData.data_retention || '3');
        formData.append('photographer_id', eventData.photographer_id || '');
        formData.append('photographer_ids', eventData.photographer_ids || '[]');
        formData.append('event_type', eventData.type || 'corporate');
        formData.append('owner_email', eventData.owner_email || '');
        formData.append('event_size', eventData.eventSize || '1-300');

        // Pass the current origin to generate correct QR links
        formData.append('registration_url_base', window.location.origin);

        return apiCall('/events/create', {
            method: 'POST',
            body: formData,
        });
    },

    /**
     * Get all events
     */
    getAll: async () => {
        return apiCall('/events/');
    },

    /**
     * Get event by ID
     */
    getById: async (eventId) => {
        return apiCall(`/events/${eventId}`);
    },

    /**
     * Delete an event
     */
    delete: async (eventId) => {
        return apiCall(`/events/${eventId}`, {
            method: 'DELETE',
        });
    },
};

// ==========================================
// ATTENDEE APIs
// ==========================================

export const attendeeAPI = {
    /**
     * Register an attendee with selfie (calls AI API for face processing)
     */
    register: async (attendeeData, selfieBlob, selfieFileName = 'selfie.jpg') => {
        const formData = new FormData();
        formData.append('event_id', attendeeData.eventId);
        formData.append('name', attendeeData.fullName);
        formData.append('email', attendeeData.email);
        formData.append('phone', attendeeData.phone || '');

        if (selfieBlob) {
            formData.append('selfie', selfieBlob, selfieFileName || 'selfie.jpg');
        }

        // Registration now uses General API (port 3001) instead of AI API
        return apiCall('/attendees/register-face', {
            method: 'POST',
            body: formData,
        }, API_BASE);
    },

    /**
     * Get attendee details
     */
    getDetails: async (attendeeId) => {
        return apiCall(`/attendees/${attendeeId}`);
    },

    /**
     * Get attendee dashboard events (registered + currently active)
     */
    getMyEvents: async () => {
        return apiCall('/attendees/my/events');
    },

    /**
     * Get only the photos the attendee's face was matched in
     */
    getPhotos: async (attendeeId, eventId) => {
        const queryParams = new URLSearchParams();
        if (eventId) {
            queryParams.set('event_id', eventId);
        }
        const params = queryParams.toString() ? `?${queryParams.toString()}` : '';
        return apiCall(`/attendees/${attendeeId}/photos${params}`);
    },

    /**
     * Get attendee's highlight reel (best photos)
     */
    getHighlightReel: async (attendeeId, eventId, limit = 15) => {
        const queryParams = new URLSearchParams();
        if (eventId) {
            queryParams.set('event_id', eventId);
        }
        queryParams.set('limit', limit);
        const params = queryParams.toString() ? `?${queryParams.toString()}` : '';
        return apiCall(`/attendees/${attendeeId}/highlight-reel${params}`);
    },

    /**
     * Get people who appear in photos with the attendee
     */
    getCoAttendees: async (attendeeId) => {
        return apiCall(`/attendees/${attendeeId}/co-attendees`);
    },

    /**
     * Get photos where attendee appears with a specific person (cluster)
     */
    getPhotosWith: async (attendeeId, targetClusterId) => {
        return apiCall(`/attendees/${attendeeId}/photos-with/${targetClusterId}`);
    },

    /**
     * Download selected photos as a ZIP file
     * @param {number[]} photoIds - Array of photo IDs to download
     * @param {string} filename - Base filename for the ZIP
     * @returns {Promise<Response>} Raw fetch response (binary ZIP)
     */
    downloadPhotos: async (photoIds, filename = 'photos') => {
        return apiCall(`/attendees/photos/download-zip?filename=${encodeURIComponent(filename)}`, {
            method: 'POST',
            body: JSON.stringify(photoIds),
        });
    },

    /**
     * Upload photos for an attendee
     */
    uploadPhotos: async (attendeeId, eventId, files, onProgress) => {
        const formData = new FormData();
        if (eventId) {
            formData.append('event_id', eventId);
        }

        if (files) {
            Array.from(files).forEach((file) => {
                formData.append('files', file);
            });
        }

        // Use XMLHttpRequest for progress tracking
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();

            xhr.upload.addEventListener('progress', (e) => {
                if (e.lengthComputable && onProgress) {
                    const percent = Math.round((e.loaded / e.total) * 100);
                    onProgress(percent);
                }
            });

            xhr.addEventListener('load', () => {
                const result = parseJsonResponse(xhr.responseText);
                if (xhr.status >= 200 && xhr.status < 300) {
                    try {
                        resolve(ensureUploadSucceeded(result, 'No photos were uploaded.'));
                    } catch (error) {
                        reject(error);
                    }
                } else {
                    const error = createApiError(
                        getUploadMessage(result, `Upload failed: ${xhr.status}`),
                        xhr.status,
                        result,
                    );
                    if (xhr.status === 401) {
                        broadcastAuthExpiry(error.message);
                    }
                    reject(error);
                }
            });

            xhr.addEventListener('error', () => {
                reject(new Error('Upload failed'));
            });

            xhr.open('POST', `${API_BASE}/attendees/${attendeeId}/upload`);
            xhr.withCredentials = true;
            xhr.send(formData);
        });
    },
};

// ==========================================
// PHOTO UPLOAD APIs
// ==========================================

export const photoAPI = {
    /**
     * Upload photos for an event
     */
    uploadFolder: async (files, folderName, eventId, photographerId, onProgress) => {
        const formData = new FormData();
        formData.append('folder_name', folderName);
        formData.append('event_id', eventId);
        formData.append('photographer_id', photographerId || '1');

        if (files) {
            Array.from(files).forEach((file) => {
                formData.append('files', file);
            });
        }

        // Use XMLHttpRequest for progress tracking
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();

            xhr.upload.addEventListener('progress', (e) => {
                if (e.lengthComputable && onProgress) {
                    const percent = Math.round((e.loaded / e.total) * 100);
                    onProgress(percent);
                }
            });

            xhr.addEventListener('load', () => {
                const result = parseJsonResponse(xhr.responseText);
                if (xhr.status >= 200 && xhr.status < 300) {
                    try {
                        resolve(ensureUploadSucceeded(result, 'No photos were uploaded.'));
                    } catch (error) {
                        reject(error);
                    }
                } else {
                    let errorMsg = `Upload failed: ${xhr.status}`;
                    const parsedMessage = getUploadMessage(result, errorMsg);
                    if (parsedMessage) {
                        errorMsg = parsedMessage;
                    }
                    console.error('Upload error response:', xhr.responseText);
                    const error = createApiError(errorMsg, xhr.status, result);
                    if (xhr.status === 401) {
                        broadcastAuthExpiry(error.message);
                    }
                    reject(error);
                }
            });

            xhr.addEventListener('error', () => {
                reject(new Error('Upload failed: Network error'));
            });

            xhr.open('POST', `${API_BASE}/photos/upload-folder`);
            xhr.withCredentials = true;
            xhr.send(formData);
        });
    },

    /**
     * Get folders for an event
     */
    getFolders: async (eventId) => {
        return apiCall(`/photos/folders?event_id=${eventId}`);
    },

    /**
     * Get photos in a folder
     */
    getFolderPhotos: async (folderId, eventId, folderName) => {
        return apiCall(`/photos/folders/${folderName}/photos?event_id=${eventId}`);
    },

    /**
     * Get an event's photos (paginated, newest first)
     */
    getEventPhotos: async (eventId, limit = 60, offset = 0) => {
        return apiCall(`/photos/event?event_id=${eventId}&limit=${limit}&offset=${offset}`);
    },

    /**
     * Delete a folder and its photos
     */
    deleteFolder: async (folderName, eventId) => {
        return apiCall(`/photos/folders/${folderName}?event_id=${eventId}`, {
            method: 'DELETE',
        });
    },

    /**
     * Get upload history for an event
     */
    getUploadHistory: async (eventId) => {
        return apiCall(`/events/${eventId}/uploads`);
    },
};

// ==========================================
// TRAINING / CLUSTERING APIs
// ==========================================

export const trainingAPI = {
    /**
     * Start face detection and clustering training
     */
    startTraining: async (eventId, adminId = '1') => {
        const formData = new FormData();
        formData.append('event_id', eventId);
        formData.append('admin_id', adminId);

        // Training uses our backend General API logic to push to Lambda & SQS
        return apiCall('/clustering/start', {
            method: 'POST',
            body: formData,
        });
    },

    /**
     * Get training metrics (from General API)
     */
    getMetrics: async (eventId) => {
        const url = eventId ? `/clustering/metrics?event_id=${eventId}` : '/clustering/metrics';
        return apiCall(url);
    },

    /**
     * Get active training jobs (from General API)
     */
    getActiveJobs: async () => {
        return apiCall('/clustering/active');
    },
};

// ==========================================
// CLUSTER APIs
// ==========================================

export const clusterAPI = {
    /**
     * Get all clusters for an event
     */
    getClusters: async (eventId) => {
        return apiCall(`/clustering/clusters/${eventId}`);
    },

    /**
     * Get faces in a cluster
     */
    getClusterFaces: async (clusterId, limit = 100, offset = 0) => {
        return apiCall(`/clustering/clusters/${clusterId}/faces?limit=${limit}&offset=${offset}`);
    },

    /**
     * Update cluster name
     */
    updateName: async (clusterId, name) => {
        const formData = new FormData();
        formData.append('name', name);

        return apiCall('/clustering/clusters/rename', {
            method: 'PUT',
            body: formData,
        });
    },
};

// ==========================================
// DASHBOARD APIs
// ==========================================

export const dashboardAPI = {
    /**
     * Get dashboard statistics
     */
    getStats: async (eventId) => {
        const [metricsRes, eventsRes] = await Promise.all([
            trainingAPI.getMetrics(eventId).catch(() => null),
            eventAPI.getAll().catch(() => []),
        ]);

        return {
            metrics: metricsRes,
            events: eventsRes,
        };
    },
};

// ==========================================
// ORGANIZER APIs
// ==========================================

export const organizerAPI = {
    register: async (data) => {
        const formData = new FormData();
        formData.append('name', data.name);
        formData.append('organization', data.organization);
        formData.append('email', data.email);
        formData.append('password', data.password);
        if (data.role) {
            formData.append('role', data.role);
        }

        return apiCall('/auth/register', {
            method: 'POST',
            body: formData,
        });
    },

    login: async (data) => {
        const formData = new FormData();
        formData.append('email', data.email);
        formData.append('password', data.password);

        return apiCall('/auth/login', {
            method: 'POST',
            body: formData,
        });
    },

    getEvents: async (userId) => {
        return apiCall(`/organizer/events/${userId}`);
    },

    updateEventStatus: async (eventId, status) => {
        const formData = new FormData();
        formData.append('status', status);
        return apiCall(`/events/${eventId}/status`, {
            method: 'PUT',
            body: formData
        });
    },

    getEventHighlightReel: async (eventId, limit = 50) => {
        return apiCall(`/organizer/events/${eventId}/highlight-reel?limit=${limit}`);
    },

    getPhotographers: async () => {
        return apiCall(`/organizer/photographers`);
    },

    getPhotographersByEvent: async (eventId) => {
        return apiCall(`/organizer/photographers/${eventId}`);
    },

    assignPhotographerToEvent: async (eventId, photographerId) => {
        const formData = new FormData();
        formData.append('photographer_id', photographerId);
        return apiCall(`/organizer/photographers/${eventId}/assign`, {
            method: 'POST',
            body: formData,
        });
    },

    removePhotographerFromEvent: async (eventId, photographerId) => {
        return apiCall(`/organizer/photographers/${eventId}/remove/${photographerId}`, {
            method: 'DELETE',
        });
    },

    createPhotographer: async (data) => {
        const formData = new FormData();
        formData.append('name', data.name);
        formData.append('organization', data.organization || 'Freelance');
        formData.append('email', data.email);
        formData.append('password', data.password);
        formData.append('role', 'photographer');

        return apiCall('/auth/register', {
            method: 'POST',
            body: formData,
        });
    }
};

export const photographerAPI = {
    login: async (data) => {
        const formData = new FormData();
        formData.append('email', data.email); // Can be email or username
        formData.append('password', data.password);

        return apiCall('/auth/login', {
            method: 'POST',
            body: formData,
        });
    },

    getAssignedEvents: async (userId) => {
        return apiCall(`/photographer/events/${userId}`);
    },
};

// Export base URLs
export const S3_UPLOADS_URL = `https://photo-cluster-frontend.s3.ap-south-1.amazonaws.com`;
export const CLOUDFRONT_URL = `https://dn1aj8426jdep.cloudfront.net`;
export const UPLOADS_URL = S3_UPLOADS_URL;

// ==========================================
// AUTH APIs (OTP)
// ==========================================

export const authAPI = {
    sendOtp: async (email, eventId) => {
        const formData = new FormData();
        formData.append('email', email);
        formData.append('event_id', eventId ?? '0');
        return apiCall('/auth/send-otp', {
            method: 'POST',
            body: formData
        });
    },

    verifyOtp: async (email, otp, eventId) => {
        const formData = new FormData();
        formData.append('email', email);
        formData.append('otp', otp);
        if (eventId) {
            formData.append('event_id', eventId);
        }
        return apiCall('/auth/verify-otp', {
            method: 'POST',
            body: formData
        });
    },

    attendeeLogin: async (email, password, eventId) => {
        const formData = new FormData();
        formData.append('email', email);
        formData.append('password', password);
        if (eventId) {
            formData.append('event_id', eventId);
        }
        return apiCall('/auth/attendee-login', {
            method: 'POST',
            body: formData
        });
    },

    attendeeSignup: async ({ name, email, password, otp, eventId }) => {
        const formData = new FormData();
        formData.append('name', name);
        formData.append('email', email);
        formData.append('password', password);
        formData.append('otp', otp);
        if (eventId) {
            formData.append('event_id', eventId);
        }
        return apiCall('/auth/attendee-signup', {
            method: 'POST',
            body: formData
        });
    },

    verifyAttendee: async (email, eventId) => {
        const formData = new FormData();
        formData.append('email', email);
        if (eventId) {
            formData.append('event_id', eventId);
        }
        return apiCall('/auth/verify-attendee', {
            method: 'POST',
            body: formData
        });
    },

    sendInvitations: async (emails, eventId) => {
        const formData = new FormData();
        formData.append('emails', emails);
        formData.append('event_id', eventId);
        return apiCall('/auth/send-invitations', {
            method: 'POST',
            body: formData
        });
    }
};

export const API_BASE_URL = API_BASE;

// ==========================================
// SYSTEM APIs
// ==========================================

export const systemAPI = {
    checkApiStatus: async () => {
        try {
            const response = await fetch(`${API_BASE}/`, {
                method: 'GET',
                credentials: 'include',
                signal: AbortSignal.timeout(3000)
            });
            return response.ok;
        } catch (error) {
            console.warn("API health check failed:", error);
            return false;
        }
    },

    recognizeFace: async (imageBlob) => {
        const formData = new FormData();
        formData.append('file', imageBlob);

        return apiCall('/processing/recognize', {
            method: 'POST',
            body: formData,
        }, AI_API_BASE);
    }
};

export default {
    system: systemAPI,
    event: eventAPI,
    attendee: attendeeAPI,
    photo: photoAPI,
    training: trainingAPI,
    cluster: clusterAPI,
    dashboard: dashboardAPI,
    organizer: organizerAPI,
    photographer: photographerAPI,
    auth: authAPI,
    UPLOADS_URL,
};
