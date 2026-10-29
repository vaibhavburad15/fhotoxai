import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
    CheckCircle, FolderOpen, Image as ImageIcon, Clock, MapPin, Calendar,
    UploadCloud, Trash2, Eye, Users, X, AlertTriangle, Layers,
    AlertCircle,
} from 'lucide-react';
import '../landing.css';
import '../styles/workspace.css';
import AILoader from '../components/ui/AILoader';
import PhotosTab from '../components/workspace/PhotosTab';
import {
    eventAPI, photoAPI, API_BASE, AUTH_EXPIRED_EVENT, clearStoredAuth, trainingAPI,
} from '../services/api';
import { useToast } from '../context/ToastContext';

const TABS = [
    { id: 'photos', label: 'Photos', icon: ImageIcon },
    { id: 'people', label: 'People', icon: Users },
];

const StatChip = ({ icon: Icon, label, value }) => (
    <div style={{
        display: 'flex', alignItems: 'center', gap: '0.55rem',
        padding: '0.55rem 0.95rem',
        background: 'var(--ws-surface)', border: '1px solid var(--ws-border)',
        borderRadius: '999px',
    }}>
        <Icon size={15} style={{ color: 'var(--ws-accent)' }} />
        <span style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--ws-text)' }}>{value}</span>
        <span style={{ fontSize: '0.72rem', color: 'var(--ws-text-muted)' }}>{label}</span>
    </div>
);

const PhotographerEventPage = () => {
    const { eventId } = useParams();
    const { addToast } = useToast();

    const [loading, setLoading] = useState(true);
    const [event, setEvent] = useState(null);
    const [uploadJobs, setUploadJobs] = useState([]);
    const [user, setUser] = useState(null);
    const [activeTab, setActiveTab] = useState('photos');
    const [galleryVersion, setGalleryVersion] = useState(0);

    // Photo upload state (existing behavior preserved)
    const [isUploading, setIsUploading] = useState(false);
    const [uploadProgress, setUploadProgress] = useState(0);
    const [uploadStats, setUploadStats] = useState({ totalFiles: 0, uploadedFiles: 0 });
    const fileInputRef = useRef(null);
    const folderInputRef = useRef(null);

    // Upload complete modal
    const [showCompleteModal, setShowCompleteModal] = useState(false);
    const [isMarkingComplete, setIsMarkingComplete] = useState(false);

    // Folder view/delete modals
    const [showViewModal, setShowViewModal] = useState(false);
    const [selectedFolder, setSelectedFolder] = useState(null);
    const [folderPhotos, setFolderPhotos] = useState([]);
    const [loadingPhotos, setLoadingPhotos] = useState(false);
    const [showDeleteModal, setShowDeleteModal] = useState(false);
    const [folderToDelete, setFolderToDelete] = useState(null);
    const [isDeleting, setIsDeleting] = useState(false);

    // People tab data
    const [metrics, setMetrics] = useState(null);
    const [metricsLoading, setMetricsLoading] = useState(false);
    const [metricsError, setMetricsError] = useState(null);

    const uploadFinalized = event?.photos_upload_complete === 1;

    const handleAuthExpired = () => {
        clearStoredAuth();
        window.dispatchEvent(new CustomEvent(AUTH_EXPIRED_EVENT, {
            detail: { message: 'Your session expired. Please log in again.' },
        }));
    };

    const loadUploadHistory = useCallback(async () => {
        try {
            const response = await fetch(`${API_BASE}/events/${eventId}/uploads`, {
                credentials: 'include',
            });
            if (response.ok) {
                const data = await response.json();
                const serverJobs = data.uploads || [];
                setUploadJobs(prev => {
                    const virtualJobs = prev.filter(j =>
                        String(j.id).startsWith('virtual-') &&
                        !serverJobs.some(sj => sj.folder_name === j.folder_name)
                    );
                    return [...virtualJobs, ...serverJobs];
                });
            } else if (response.status === 401) {
                handleAuthExpired();
            }
        } catch (error) {
            setUploadJobs([]);
        }
    }, [eventId]);

    const loadEventData = useCallback(async () => {
        try {
            const result = await eventAPI.getById(eventId);
            if (result && result.event) setEvent(result.event);
            else if (result) setEvent(result);
            await loadUploadHistory();
            setLoading(false);
        } catch (error) {
            console.error("Failed to load event:", error);
            addToast("Failed to load event details", "error");
            setLoading(false);
        }
    }, [eventId, addToast, loadUploadHistory]);

    useEffect(() => {
        const storedUser = localStorage.getItem('photographer_user');
        if (storedUser) setUser(JSON.parse(storedUser));
        loadEventData();
    }, [eventId, loadEventData]);

    // Poll photo upload history while anything is active.
    useEffect(() => {
        const hasActiveJobs = uploadJobs.some(job =>
            ['uploading', 'processing', 'in_progress', 'queued'].includes(job.status?.toLowerCase())
        );
        if (!isUploading && !hasActiveJobs) return undefined;
        const interval = setInterval(() => { loadUploadHistory(); }, 3000);
        return () => clearInterval(interval);
    }, [isUploading, uploadJobs, loadUploadHistory]);

    // Load People metrics lazily
    useEffect(() => {
        if (activeTab !== 'people' || metrics || metricsLoading) return;
        setMetricsLoading(true);
        trainingAPI.getMetrics(eventId)
            .then((data) => setMetrics(data))
            .catch((err) => setMetricsError(err.message || 'Failed to load metrics'))
            .finally(() => setMetricsLoading(false));
    }, [activeTab, eventId, metrics, metricsLoading]);

    const handleViewFolder = async (folderName) => {
        setSelectedFolder(folderName);
        setShowViewModal(true);
        setLoadingPhotos(true);
        try {
            const data = await photoAPI.getFolderPhotos(null, eventId, folderName);
            setFolderPhotos(data || []);
        } catch (_error) {
            addToast("Failed to load photos", "error");
        } finally {
            setLoadingPhotos(false);
        }
    };

    const handleDeleteFolder = async () => {
        if (!folderToDelete) return;
        setIsDeleting(true);
        try {
            await photoAPI.deleteFolder(folderToDelete, eventId);
            addToast("Folder deleted successfully", "success");
            setShowDeleteModal(false);
            setFolderToDelete(null);
            await loadUploadHistory();
            loadEventData();
            setGalleryVersion(v => v + 1);
        } catch (error) {
            console.error("Failed to delete folder:", error);
            addToast("Failed to delete folder", "error");
        } finally {
            setIsDeleting(false);
        }
    };

    const handleFileSelect = async (e, isFolder = false) => {
        const rawFiles = e.target.files;
        if (!rawFiles?.length) return;

        const allowedExtensions = ['.jpg', '.jpeg', '.png', '.webp'];
        const validFiles = Array.from(rawFiles).filter(file => {
            const lowerName = file.name.toLowerCase();
            return allowedExtensions.some(ext => lowerName.endsWith(ext));
        });

        if (validFiles.length === 0) {
            addToast("No valid files selected. Allowed: .jpg, .jpeg, .png, .webp", "error");
            if (fileInputRef.current) fileInputRef.current.value = '';
            return;
        }

        const currentUser = user || { id: 1 };
        setIsUploading(true);
        setUploadProgress(0);
        setUploadStats({ totalFiles: validFiles.length, uploadedFiles: 0 });

        try {
            const folderName = isFolder
                ? validFiles[0]?.webkitRelativePath?.split('/')[0] || 'Folder Upload'
                : `Batch Upload ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }).replace(/:/g, '-')}`;

            const virtualJob = {
                id: 'virtual-' + Date.now(),
                folder_name: folderName,
                photos_uploaded: 0,
                total_photos: validFiles.length,
                created_at: new Date().toISOString(),
                status: 'uploading'
            };
            setUploadJobs(prev => [virtualJob, ...prev]);

            const result = await photoAPI.uploadFolder(
                validFiles,
                folderName,
                eventId,
                currentUser.id,
                (percent) => {
                    setUploadProgress(percent);
                    const uploadedCount = Math.floor((percent / 100) * validFiles.length);
                    setUploadStats(prev => ({ ...prev, uploadedFiles: uploadedCount }));
                    setUploadJobs(prev => prev.map(job =>
                        job.id === virtualJob.id
                            ? { ...job, photos_uploaded: uploadedCount, progress: percent }
                            : job
                    ));
                }
            );

            if ((result?.failed ?? 0) > 0) {
                addToast(`Uploaded ${result.uploaded} photo(s). ${result.failed} failed.`, 'info');
            } else {
                addToast(result.message || `Uploaded ${result.uploaded} photo(s) successfully.`, 'success');
            }

            await loadUploadHistory();
            loadEventData();
            setGalleryVersion(v => v + 1);
        } catch (error) {
            console.error('Upload error:', error);
            addToast(error.message || 'Upload failed', 'error');
            await loadUploadHistory();
        } finally {
            setIsUploading(false);
            if (fileInputRef.current) fileInputRef.current.value = '';
            if (folderInputRef.current) folderInputRef.current.value = '';
        }
    };

    const handleMarkComplete = async () => {
        setIsMarkingComplete(true);
        try {
            const formData = new FormData();
            formData.append('status', 'completed');
            const response = await fetch(`${API_BASE}/events/${eventId}/status`, {
                method: 'PUT',
                body: formData,
                credentials: 'include',
            });

            if (response.ok) {
                addToast('Upload marked as complete', 'success');
                setShowCompleteModal(false);
                await loadEventData();
            } else if (response.status === 401) {
                handleAuthExpired();
            } else {
                addToast('Failed to mark upload as complete', 'error');
            }
        } catch (error) {
            console.error('Error marking complete:', error);
            addToast('Failed to mark upload as complete', 'error');
        } finally {
            setIsMarkingComplete(false);
        }
    };

    const formatTime = (timestamp) => {
        if (!timestamp) return '--';
        return new Date(timestamp).toLocaleDateString('en-US', {
            month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
        });
    };

    if (loading) {
        return (
            <div className="ws-page" style={{ minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <AILoader active={true} text="SYNCING EVENT" />
            </div>
        );
    }

    return (
        <div className="ws-page" style={{ position: 'fixed', inset: 0, zIndex: 40, paddingTop: '76px', boxSizing: 'border-box', overflowY: 'auto' }}>
            <style>{`
                @keyframes ws-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
                .ws-event-grid { display: grid; grid-template-columns: 1fr; gap: 1.5rem; max-width: 1200px; margin: 0 auto; padding: 0 1.5rem 3rem; }
                .ws-event-toolbar { display: flex; align-items: flex-end; justify-content: space-between; gap: 1rem; flex-wrap: wrap; max-width: 1200px; margin: 0 auto; padding: 0 1.5rem; }
                @media (max-width: 768px) {
                    .ws-event-toolbar { flex-direction: column; align-items: stretch; }
                }
            `}</style>

            {/* Event header + status */}
            <div style={{ maxWidth: '1200px', margin: '0 auto', padding: '2rem 1.5rem 1.25rem' }}>
                <Link to="/photographer/dashboard" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.85rem', color: 'var(--ws-text-muted)', textDecoration: 'none', fontWeight: 500 }}>
                    ← Back to Dashboard
                </Link>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem', flexWrap: 'wrap', marginTop: '0.75rem' }}>
                    <div>
                        <div style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.6rem' }}>
                            <span style={{
                                padding: '0.2rem 0.7rem', borderRadius: '999px',
                                background: 'var(--ws-accent-soft)', color: 'var(--ws-accent)',
                                fontSize: '0.7rem', fontWeight: 800, letterSpacing: '0.06em',
                            }}>
                                EVENT #{event?.id}
                            </span>
                            {uploadFinalized ? (
                                <span className="ws-badge ws-badge--completed"><CheckCircle size={11} /> Finalized</span>
                            ) : (
                                <span className="ws-badge ws-badge--processing">Open for uploads</span>
                            )}
                        </div>
                        <h1 style={{ fontSize: '2rem', fontWeight: 800, margin: 0, letterSpacing: '-0.02em', lineHeight: 1.2, color: 'var(--ws-text)' }}>
                            {event?.name}
                        </h1>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '1.1rem', marginTop: '0.6rem', color: 'var(--ws-text-secondary)', fontSize: '0.88rem', flexWrap: 'wrap' }}>
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}><MapPin size={15} /> {event?.location || 'TBD'}</span>
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}><Calendar size={15} /> {new Date(event?.date).toLocaleDateString()}</span>
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}><Clock size={15} /> {event?.event_time || 'All Day'}</span>
                        </div>
                    </div>
                    <div style={{ display: 'flex', gap: '0.55rem', flexWrap: 'wrap' }}>
                        <StatChip icon={ImageIcon} value={metrics?.totalPhotos ?? event?.photo_count ?? 0} label="photos" />
                        <StatChip icon={Layers} value={metrics?.uniqueIdentities ?? 0} label="people" />
                    </div>
                </div>

                {/* Tabs */}
                <div className="ws-tabs" role="tablist" aria-label="Event workspace sections" style={{ marginTop: '1.5rem' }}>
                    {TABS.map((tab) => {
                        const Icon = tab.icon;
                        return (
                            <button
                                key={tab.id}
                                role="tab"
                                aria-selected={activeTab === tab.id}
                                className="ws-tab"
                                onClick={() => setActiveTab(tab.id)}
                            >
                                <Icon size={15} /> {tab.label}
                            </button>
                        );
                    })}
                </div>
            </div>

            {/* Tab panels */}
            <div style={{ maxWidth: '1200px', margin: '0 auto', padding: '0 1.5rem 3rem' }}>
                {activeTab === 'photos' && (
                    <div>
                        {/* Upload actions (preserved behavior) */}
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', marginBottom: '1.75rem' }}>
                            {uploadFinalized && (
                                <div className="ws-card" style={{ padding: '1rem 1.25rem', background: 'var(--ws-success-soft)', border: '1px solid #a7f3d0', display: 'flex', gap: '0.75rem', alignItems: 'flex-start' }}>
                                    <CheckCircle size={20} style={{ color: 'var(--ws-success)', flexShrink: 0, marginTop: 2 }} />
                                    <div style={{ fontSize: '0.85rem', color: '#065f46', lineHeight: 1.5 }}>
                                        <strong>Upload finalized.</strong> Upload and delete are disabled for this event.
                                    </div>
                                </div>
                            )}
                            {!uploadFinalized && (
                                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '1rem' }}>
                                    <button
                                        className="ws-card"
                                        onClick={() => folderInputRef.current?.click()}
                                        disabled={isUploading}
                                        style={{ padding: '1.25rem', display: 'flex', gap: '0.9rem', alignItems: 'center', cursor: isUploading ? 'not-allowed' : 'pointer', textAlign: 'left', border: '1px solid var(--ws-border)' }}
                                        onMouseEnter={(e) => { if (!isUploading) e.currentTarget.style.borderColor = 'var(--ws-accent-border)'; }}
                                        onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--ws-border)'; }}
                                    >
                                        <div style={{ width: 44, height: 44, borderRadius: 11, background: 'var(--ws-accent-soft)', color: 'var(--ws-accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                                            <FolderOpen size={22} />
                                        </div>
                                        <div>
                                            <div style={{ fontWeight: 700, fontSize: '0.95rem' }}>Upload Folder</div>
                                            <div style={{ fontSize: '0.8rem', color: 'var(--ws-text-muted)' }}>Bulk upload a directory at once</div>
                                        </div>
                                    </button>
                                    <button
                                        className="ws-card"
                                        onClick={() => fileInputRef.current?.click()}
                                        disabled={isUploading}
                                        style={{ padding: '1.25rem', display: 'flex', gap: '0.9rem', alignItems: 'center', cursor: isUploading ? 'not-allowed' : 'pointer', textAlign: 'left', border: '1px solid var(--ws-border)' }}
                                        onMouseEnter={(e) => { if (!isUploading) e.currentTarget.style.borderColor = 'var(--ws-accent-border)'; }}
                                        onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--ws-border)'; }}
                                    >
                                        <div style={{ width: 44, height: 44, borderRadius: 11, background: 'var(--ws-accent-soft)', color: 'var(--ws-accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                                            <ImageIcon size={22} />
                                        </div>
                                        <div>
                                            <div style={{ fontWeight: 700, fontSize: '0.95rem' }}>Upload Photos</div>
                                            <div style={{ fontSize: '0.8rem', color: 'var(--ws-text-muted)' }}>Select JPG / PNG / WebP files</div>
                                        </div>
                                    </button>
                                </div>
                            )}
                        </div>

                        {/* Gallery */}
                        <PhotosTab eventId={eventId} refreshKey={galleryVersion} />

                        {/* Upload history */}
                        <div style={{ marginTop: '2rem' }}>
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem' }}>
                                <h3 className="ws-section-title" style={{ margin: 0 }}>Upload history</h3>
                                <span style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--ws-text-faint)' }}>{uploadJobs.length} sessions</span>
                            </div>
                            <div className="ws-card" style={{ overflow: 'hidden' }}>
                                <div style={{ overflowX: 'auto' }}>
                                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.88rem' }}>
                                        <thead style={{ background: '#fafbfc', borderBottom: '1px solid var(--ws-border)' }}>
                                            <tr>
                                                <th style={{ textAlign: 'left', padding: '0.85rem 1.25rem', fontWeight: 600, color: 'var(--ws-text-muted)', fontSize: '0.72rem', letterSpacing: '0.06em' }}>SOURCE</th>
                                                <th style={{ textAlign: 'left', padding: '0.85rem 1.25rem', fontWeight: 600, color: 'var(--ws-text-muted)', fontSize: '0.72rem', letterSpacing: '0.06em' }}>COUNT</th>
                                                <th style={{ textAlign: 'left', padding: '0.85rem 1.25rem', fontWeight: 600, color: 'var(--ws-text-muted)', fontSize: '0.72rem', letterSpacing: '0.06em' }}>DATE</th>
                                                <th style={{ textAlign: 'center', padding: '0.85rem 1.25rem', fontWeight: 600, color: 'var(--ws-text-muted)', fontSize: '0.72rem', letterSpacing: '0.06em' }}>STATUS</th>
                                                <th style={{ textAlign: 'right', padding: '0.85rem 1.25rem', fontWeight: 600, color: 'var(--ws-text-muted)', fontSize: '0.72rem', letterSpacing: '0.06em' }}>ACTIONS</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {uploadJobs.length > 0 ? (
                                                uploadJobs.map((job, index) => (
                                                    <tr key={index} style={{ borderBottom: '1px solid #f1f2f4' }}>
                                                        <td style={{ padding: '0.85rem 1.25rem', fontWeight: 500, display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                                                            <FolderOpen size={15} style={{ color: 'var(--ws-text-faint)' }} />
                                                            {job.folder_name || 'Manual Upload'}
                                                        </td>
                                                        <td style={{ padding: '0.85rem 1.25rem', color: 'var(--ws-text-secondary)' }}>
                                                            {job.photos_uploaded || job.total_photos || 0}
                                                        </td>
                                                        <td style={{ padding: '0.85rem 1.25rem', color: 'var(--ws-text-faint)' }}>{formatTime(job.created_at)}</td>
                                                        <td style={{ padding: '0.85rem 1.25rem', textAlign: 'center' }}>
                                                            {(() => {
                                                                const status = job.status?.toLowerCase() || '';
                                                                const isDone = ['completed', 'success', 'done'].includes(status);
                                                                const isFailed = ['failed', 'error'].includes(status);
                                                                const isUploadingJob = status === 'uploading';
                                                                return (
                                                                    <span className={`ws-badge ${isDone ? 'ws-badge--completed' : isFailed ? 'ws-badge--failed' : isUploadingJob ? 'ws-badge--uploading' : 'ws-badge--processing'}`}>
                                                                        {isDone ? 'DONE' : isFailed ? 'FAILED' : isUploadingJob ? 'UPLOADING…' : 'PROCESSING'}
                                                                    </span>
                                                                );
                                                            })()}
                                                        </td>
                                                        <td style={{ padding: '0.85rem 1.25rem', textAlign: 'right' }}>
                                                            <div style={{ display: 'flex', gap: '0.4rem', justifyContent: 'flex-end' }}>
                                                                <button className="ws-btn ws-btn--ghost" onClick={() => handleViewFolder(job.folder_name)} aria-label={`View folder ${job.folder_name}`} title="View photos">
                                                                    <Eye size={15} />
                                                                </button>
                                                                {!uploadFinalized && !job.id?.toString().startsWith('virtual-') && (
                                                                    <button
                                                                        className="ws-btn ws-btn--danger"
                                                                        onClick={() => { setFolderToDelete(job.folder_name); setShowDeleteModal(true); }}
                                                                        aria-label={`Delete folder ${job.folder_name}`} title="Delete folder"
                                                                    >
                                                                        <Trash2 size={15} />
                                                                    </button>
                                                                )}
                                                            </div>
                                                        </td>
                                                    </tr>
                                                ))
                                            ) : (
                                                <tr><td colSpan={5} style={{ padding: '2.5rem', textAlign: 'center', color: 'var(--ws-text-faint)' }}>No uploads recorded yet.</td></tr>
                                            )}
                                        </tbody>
                                    </table>
                                </div>
                                {!uploadFinalized && (
                                    <div style={{ padding: '1rem', borderTop: '1px solid var(--ws-border)', background: '#fafbfc' }}>
                                        <button className="ws-btn" style={{ width: '100%', background: 'var(--ws-success)', borderColor: 'var(--ws-success)', color: '#fff' }} onClick={() => setShowCompleteModal(true)}>
                                            <CheckCircle size={16} /> Mark Upload as Complete
                                        </button>
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                )}

                {activeTab === 'people' && (
                    <div>
                        {metricsLoading ? (
                            <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--ws-text-muted)' }}>
                                <AILoader active text="LOADING METRICS" />
                            </div>
                        ) : metricsError ? (
                            <div className="ws-card" style={{ padding: '1.5rem', color: 'var(--ws-danger)', fontSize: '0.88rem' }}>
                                {metricsError}
                            </div>
                        ) : (
                            <>
                                <div className="ws-counter-grid" style={{ marginBottom: '1.25rem' }}>
                                    <div className="ws-counter ws-counter--accent">
                                        <div className="ws-counter__value">{metrics?.totalPhotos ?? 0}</div>
                                        <div className="ws-counter__label">Photos</div>
                                    </div>
                                    <div className="ws-counter">
                                        <div className="ws-counter__value">{metrics?.totalFaces ?? 0}</div>
                                        <div className="ws-counter__label">Faces detected</div>
                                    </div>
                                    <div className="ws-counter">
                                        <div className="ws-counter__value">{metrics?.uniqueIdentities ?? 0}</div>
                                        <div className="ws-counter__label">People grouped</div>
                                    </div>
                                    <div className="ws-counter">
                                        <div className="ws-counter__value">{metrics?.attendeeCount ?? metrics?.attendee_count ?? 0}</div>
                                        <div className="ws-counter__label">Registered attendees</div>
                                    </div>
                                </div>
                                <div className="ws-card" style={{ padding: '1.25rem', display: 'flex', gap: '0.75rem', alignItems: 'flex-start' }}>
                                    <AlertCircle size={18} style={{ color: 'var(--ws-accent)', flexShrink: 0, marginTop: 2 }} />
                                    <div style={{ fontSize: '0.85rem', color: 'var(--ws-text-secondary)', lineHeight: 1.55 }}>
                                        <strong style={{ display: 'block', color: 'var(--ws-text)' }}>Clustering runs from the organizer dashboard</strong>
                                        Photo grouping is started by the organizer through the existing workflow
                                        (Organizer Dashboard → Clustering). Newly uploaded photos appear in People
                                        after the organizer re-runs clustering.
                                    </div>
                                </div>
                                <a
                                    href="/photo-clustering"
                                    className="ws-btn ws-btn--primary"
                                    style={{ marginTop: '1.25rem', textDecoration: 'none' }}
                                >
                                    <Users size={15} /> Open People / Clustering screen
                                </a>
                            </>
                        )}
                    </div>
                )}
            </div>

            {/* Upload progress panel (existing behavior; upload duration only) */}
            {isUploading && (
                <div className="ws-card" style={{ position: 'fixed', bottom: '2rem', right: '2rem', width: 340, padding: '1.25rem', zIndex: 100, boxShadow: 'var(--ws-shadow-lg)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                            <UploadCloud size={18} style={{ color: 'var(--ws-accent)' }} />
                            <div style={{ fontWeight: 700, fontSize: '0.9rem' }}>Transferring photos…</div>
                        </div>
                        <div style={{ fontSize: '0.85rem', fontWeight: 800, color: 'var(--ws-accent)' }}>{uploadProgress}%</div>
                    </div>
                    <div className="ws-progress">
                        <div className="ws-progress__bar" style={{ width: `${uploadProgress}%` }} />
                    </div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--ws-text-muted)', marginTop: '0.6rem' }}>
                        {uploadStats.uploadedFiles} / {uploadStats.totalFiles} files (file transfer only)
                    </div>
                </div>
            )}

            {/* Finalize upload confirmation */}
            {showCompleteModal && (
                <div role="dialog" aria-modal="true" aria-label="Finalize uploads"
                    onMouseDown={(e) => { if (e.target === e.currentTarget && !isMarkingComplete) setShowCompleteModal(false); }}
                    style={{ position: 'fixed', inset: 0, background: 'rgba(17,24,39,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200, padding: '1rem' }}>
                    <div className="ws-card" style={{ maxWidth: 480, width: '100%', overflow: 'hidden' }}>
                        <div style={{ padding: '1.25rem 1.5rem', borderBottom: '1px solid var(--ws-border)', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                            <div style={{ width: 40, height: 40, borderRadius: 10, background: 'var(--ws-danger-soft)', color: 'var(--ws-danger)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                <AlertTriangle size={20} />
                            </div>
                            <h3 style={{ fontSize: '1.15rem', fontWeight: 700, margin: 0 }}>Finalize upload?</h3>
                            <button className="ws-btn ws-btn--ghost" style={{ marginLeft: 'auto' }} aria-label="Close dialog" onClick={() => setShowCompleteModal(false)} disabled={isMarkingComplete}>
                                <X size={18} />
                            </button>
                        </div>
                        <div style={{ padding: '1.5rem' }}>
                            <div style={{ background: 'var(--ws-danger-soft)', border: '1px solid #fca5a5', borderRadius: 12, padding: '1rem', marginBottom: '1rem', fontSize: '0.88rem', color: '#991b1b', lineHeight: 1.6 }}>
                                Once finalized you can no longer upload or delete photos for this event. This cannot be undone.
                            </div>
                            <p style={{ fontSize: '0.9rem', color: 'var(--ws-text-secondary)', lineHeight: 1.6, margin: 0 }}>
                                Finalize uploads for <strong style={{ color: 'var(--ws-text)' }}>{event?.name}</strong>?
                            </p>
                            <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end', marginTop: '1.5rem' }}>
                                <button className="ws-btn" onClick={() => setShowCompleteModal(false)} disabled={isMarkingComplete}>Cancel</button>
                                <button className="ws-btn ws-btn--primary" onClick={handleMarkComplete} disabled={isMarkingComplete}>
                                    {isMarkingComplete ? 'Submitting…' : (<><CheckCircle size={15} /> Yes, finalize</>)}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Folder photos modal */}
            {showViewModal && (
                <div role="dialog" aria-modal="true" aria-label={`Folder ${selectedFolder} photos`}
                    onMouseDown={(e) => { if (e.target === e.currentTarget) setShowViewModal(false); }}
                    style={{ position: 'fixed', inset: 0, background: 'rgba(17,24,39,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 300, padding: '1.5rem' }}>
                    <div className="ws-card" style={{ width: '100%', maxWidth: 960, maxHeight: '85vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                        <div style={{ padding: '1rem 1.5rem', borderBottom: '1px solid var(--ws-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                            <div>
                                <h3 style={{ fontSize: '1.1rem', fontWeight: 800, margin: 0 }}>{selectedFolder}</h3>
                                <div style={{ fontSize: '0.8rem', color: 'var(--ws-text-muted)', marginTop: '0.2rem' }}>
                                    {folderPhotos.length} photos in this session
                                </div>
                            </div>
                            <button className="ws-btn ws-btn--ghost" aria-label="Close folder view" onClick={() => setShowViewModal(false)}>
                                <X size={18} />
                            </button>
                        </div>
                        <div style={{ flex: 1, overflowY: 'auto', padding: '1.5rem' }}>
                            {loadingPhotos ? (
                                <AILoader active text="FETCHING PHOTOS" />
                            ) : (
                                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: '1rem' }}>
                                    {folderPhotos.map((photo) => (
                                        <div key={photo.id} style={{ aspectRatio: '1', borderRadius: 12, overflow: 'hidden', background: '#f1f2f4', border: '1px solid var(--ws-border)' }}>
                                            <img
                                                src={photo.file_path}
                                                alt={photo.original_filename}
                                                loading="lazy"
                                                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                                                onError={(e) => { e.currentTarget.style.opacity = 0.2; }}
                                            />
                                        </div>
                                    ))}
                                    {folderPhotos.length === 0 && (
                                        <div style={{ gridColumn: '1/-1', textAlign: 'center', padding: '3rem', color: 'var(--ws-text-faint)' }}>
                                            <ImageIcon size={36} style={{ opacity: 0.3, marginBottom: '0.5rem' }} />
                                            <p>No photos found in this folder.</p>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* Delete folder confirmation */}
            {showDeleteModal && (
                <div role="dialog" aria-modal="true" aria-label="Delete folder"
                    onMouseDown={(e) => { if (e.target === e.currentTarget && !isDeleting) setShowDeleteModal(false); }}
                    style={{ position: 'fixed', inset: 0, background: 'rgba(17,24,39,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 300, padding: '1rem' }}>
                    <div className="ws-card" style={{ maxWidth: 440, width: '100%', overflow: 'hidden' }}>
                        <div style={{ padding: '1.25rem 1.5rem', borderBottom: '1px solid var(--ws-border)', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                            <div style={{ width: 40, height: 40, borderRadius: 10, background: 'var(--ws-danger-soft)', color: 'var(--ws-danger)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                <Trash2 size={20} />
                            </div>
                            <h3 style={{ fontSize: '1.15rem', fontWeight: 700, margin: 0 }}>Delete folder?</h3>
                        </div>
                        <div style={{ padding: '1.5rem' }}>
                            <p style={{ fontSize: '0.9rem', color: 'var(--ws-text-secondary)', lineHeight: 1.6, margin: 0 }}>
                                Permanently delete <strong style={{ color: 'var(--ws-text)' }}>{folderToDelete}</strong> and
                                every photo in it from the event and the server?
                            </p>
                            <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end', marginTop: '1.5rem' }}>
                                <button className="ws-btn" onClick={() => setShowDeleteModal(false)} disabled={isDeleting}>Cancel</button>
                                <button className="ws-btn ws-btn--danger" onClick={handleDeleteFolder} disabled={isDeleting}>
                                    {isDeleting ? 'Deleting…' : (<><Trash2 size={15} /> Delete</>)}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Hidden file inputs (existing behavior) */}
            <input type="file" ref={fileInputRef} multiple accept="image/*" style={{ display: 'none' }} onChange={(e) => handleFileSelect(e, false)} />
            <input type="file" ref={folderInputRef} webkitdirectory="" directory="" multiple style={{ display: 'none' }} onChange={(e) => handleFileSelect(e, true)} />
        </div>
    );
};

export default PhotographerEventPage;
