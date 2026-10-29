import React, { useState, useEffect, useCallback } from 'react';
import { useParams, Link, useSearchParams, useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { getClusterFaces, updateClusterName, getPhotoUrl, getAttendeeDetails } from '../utils/photoClusteringApi';
import { attendeeAPI, API_BASE } from '../services/api';
import '../components/photoClustering/ui/ClusterViewer.css';
import CinematicManager from '../components/photoClustering/ui/cinematic/CinematicManager';
import CollageManager from '../components/photoClustering/ui/collage/CollageManager';
import FlipbookManager from '../components/photoClustering/ui/flipbook/FlipbookManager';
import { LogOut, Edit2, Check, X, Sparkles, Image as ImageIcon, Camera, Download, Loader2, Play, Home, ChevronRight, User, Layout, ChevronLeft, Upload, BookOpen } from 'lucide-react';
import '../landing.css';
import '../styles/dashboard-theme.css';
import AILoader from '../components/ui/AILoader';
import JSZip from 'jszip';
import { saveAs } from 'file-saver';
import { useToast } from '../context/ToastContext';

// --- Shared Components (Mature SaaS) ---

const StandardCard = ({ children, style = {} }) => (
    <div style={{
        background: 'rgba(255, 255, 255, 0.88)',
        border: '1px solid rgba(37, 30, 24, 0.08)',
        borderRadius: '1.25rem',
        boxShadow: '0 4px 12px -6px rgba(66, 35, 5, 0.18)',
        overflow: 'hidden',
        ...style
    }}>
        {children}
    </div>
);

const AttendeeDashboard = () => {
    const { clusterId } = useParams();
    const navigate = useNavigate();
    const { addToast } = useToast();
    const [faces, setFaces] = useState([]);
    const [cluster, setCluster] = useState(null);
    const [loading, setLoading] = useState(true);
    const [totalFaces, setTotalFaces] = useState(0);
    const [isEditing, setIsEditing] = useState(false);
    const [newName, setNewName] = useState('');
    const [selectedFace, setSelectedFace] = useState(null);
    const [showMemories, setShowMemories] = useState(false);
    const [showCollage, setShowCollage] = useState(false);
    const [showFlipbook, setShowFlipbook] = useState(false);
    const [allPhotos, setAllPhotos] = useState(null);
    const [isOpeningPremiumView, setIsOpeningPremiumView] = useState(false);
    const [isDownloading, setIsDownloading] = useState(false);
    const [allEvents, setAllEvents] = useState([]);
    const [profileEmail, setProfileEmail] = useState('');
    const [profileName, setProfileName] = useState('');
    
    // New Features: Highlight Reel & Co-Attendees
    const [highlightReel, setHighlightReel] = useState([]);
    const [coAttendees, setCoAttendees] = useState([]);
    const [viewMode, setViewMode] = useState('all'); // 'all', 'highlight', 'with'
    const [selectedCoAttendee, setSelectedCoAttendee] = useState('');
    const [displayedFaces, setDisplayedFaces] = useState([]);
    const [eventsExpanded, setEventsExpanded] = useState(false);

    const facesPerPage = 50;
    const apiUrl = API_BASE;

    const [searchParams] = useSearchParams();
    const eventId = searchParams.get('eventId');

    // Load content
    useEffect(() => {
        async function fetchClusterFaces() {
            if (!clusterId) return;
            setLoading(true);
            try {
                if (clusterId.startsWith('attendee-')) {
                    const attendeeId = clusterId.replace('attendee-', '');
                    try {
                        const attData = await getAttendeeDetails(attendeeId);

                        if (attData.status === 'success' && attData.attendee) {
                            setCluster({ cluster_name: attData.attendee.name, event_name: attData.attendee.event_name });
                        } else {
                            setCluster({ cluster_name: 'Attendee' });
                        }

                            try {
                                const photoData = await attendeeAPI.getPhotos(attendeeId, eventId);
                                if (photoData.status === 'success') {
                                    const formattedFaces = (photoData.faces || []).map(f => ({
                                        ...f,
                                        photo_url: f.photo_url || f.url || f.thumbnail_url
                                    }));
                                    setFaces(formattedFaces);
                                    setDisplayedFaces(formattedFaces);
                                    setTotalFaces(photoData.total || 0);
                                    if (photoData.attendee_name) {
                                        setCluster(prev => ({
                                            ...prev,
                                            cluster_name: photoData.attendee_name,
                                            event_name: prev?.event_name || photoData.event_name
                                        }));
                                    }
                                }
                                
                                // Fetch Highlights
                                const highlightData = await attendeeAPI.getHighlightReel(attendeeId, eventId, 15).catch(()=>null);
                                if (highlightData?.status === 'success') {
                                    setHighlightReel(highlightData.faces || []);
                                }

                                // Fetch Co-Attendees
                                const coData = await attendeeAPI.getCoAttendees(attendeeId).catch(()=>null);
                                if (coData?.status === 'success') {
                                    setCoAttendees(coData.co_attendees || []);
                                }

                            } catch (_e) {
                                console.error("Photo fetch error");
                            }
                    } catch (_e) {
                        console.error("Attendee fetch error");
                        setCluster({ cluster_name: 'Attendee' });
                    }
                    setLoading(false);
                    return;
                }

                if (clusterId === 'demo_cluster_1') {
                    await new Promise(r => setTimeout(r, 800));
                    setFaces([
                        { id: 1, photo_url: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=400&h=400&fit=crop' },
                        { id: 2, photo_url: 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=400&h=400&fit=crop' },
                        { id: 3, photo_url: 'https://images.unsplash.com/photo-1539571696357-5a69c17a67c6?w=400&h=400&fit=crop' },
                        { id: 4, photo_url: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=400&h=400&fit=crop' },
                    ]);
                    setCluster({ cluster_name: 'Demo User' });
                    setTotalFaces(4);
                    setNewName('Demo User');
                    setLoading(false);
                    return;
                }

                const idToFetch = parseInt(clusterId);
                const targetId = isNaN(idToFetch) ? clusterId : idToFetch;

                const data = await getClusterFaces(targetId, facesPerPage, 0);
                setFaces(data.faces || []);
                setCluster(data.cluster || {});
                setTotalFaces(data.total || 0);
                if (data.cluster?.cluster_name) setNewName(data.cluster.cluster_name);
            } catch (err) {
                console.error('Portal load error', err);
            } finally {
                setLoading(false);
            }
        }
        fetchClusterFaces();
    }, [clusterId, eventId]);

    useEffect(() => {
        if (viewMode === 'all') {
            setDisplayedFaces(faces);
        } else if (viewMode === 'highlight') {
            setDisplayedFaces(highlightReel);
        } else if (viewMode === 'with' && selectedCoAttendee) {
            // we should fetch the photos with this person
            const fetchPhotosWith = async () => {
                if (clusterId.startsWith('attendee-')) {
                    const attendeeId = clusterId.replace('attendee-', '');
                    try {
                        setLoading(true);
                        const data = await attendeeAPI.getPhotosWith(attendeeId, selectedCoAttendee);
                        if (data.status === 'success') {
                            setDisplayedFaces(data.faces || []);
                        }
                    } catch (e) {
                        console.error('Error fetching co-attendee photos', e);
                    } finally {
                        setLoading(false);
                    }
                }
            };
            fetchPhotosWith();
        }
    }, [viewMode, selectedCoAttendee, faces, highlightReel]);

    useEffect(() => {
        let isMounted = true;

        const loadAttendeeEvents = async () => {
            if (!clusterId?.startsWith('attendee-')) {
                return;
            }

            try {
                const response = await attendeeAPI.getMyEvents();
                if (!isMounted || response?.status !== 'success') {
                    return;
                }

                setAllEvents(response.all_events || []);
                setProfileEmail(response.user?.email || '');
                setProfileName(response.user?.full_name || '');
            } catch (_err) {
                // Dashboard remains usable even if event summary fails.
            }
        };

        loadAttendeeEvents();
        return () => {
            isMounted = false;
        };
    }, [clusterId]);

    const openEventGallery = (attendeeEvent) => {
        const targetAttendeeId = attendeeEvent?.attendee_id;
        const targetEventId = attendeeEvent?.event_id;
        if (!targetAttendeeId) {
            return;
        }
        navigate(`/attendee/dashboard/attendee-${targetAttendeeId}?eventId=${targetEventId}`);
    };

    const registerForEvent = (eventIdToJoin) => {
        const params = new URLSearchParams();
        params.set('eventId', String(eventIdToJoin));
        if (profileEmail) {
            params.set('email', profileEmail);
        }
        if (profileName) {
            params.set('name', profileName);
        }
        params.set('verified', 'true');
        navigate(`/attendee-registration?${params.toString()}`);
    };

    const openPremiumView = async (type) => {
        if (allPhotos && allPhotos.length > 0) {
            if (type === 'collage') setShowCollage(true);
            if (type === 'flipbook') setShowFlipbook(true);
            return;
        }

        setIsOpeningPremiumView(true);
        try {
            let fullUrls = [];
            
            // If attendee ID route, we can try to get all from standard getClusterFaces or getPhotos
            if (clusterId.startsWith('attendee-')) {
                const attendeeId = clusterId.replace('attendee-', '');
                const photoData = await attendeeAPI.getPhotos(attendeeId, eventId);
                fullUrls = (photoData.faces || []).map(f => {
                    const url = f.photo_url || f.url || f.thumbnail_url;
                    return url.startsWith('http') ? url : getPhotoUrl(url);
                });
            } else if (clusterId === 'demo_cluster_1') {
                fullUrls = faces.map(f => f.photo_url);
            } else {
                const targetId = isNaN(parseInt(clusterId)) ? clusterId : parseInt(clusterId);
                const data = await getClusterFaces(targetId, 1000, 0);
                fullUrls = (data.faces || []).map(f => f.photo_url.startsWith('http') ? f.photo_url : getPhotoUrl(f.photo_url));
            }
            
            setAllPhotos(fullUrls);
            if (type === 'collage') setShowCollage(true);
            if (type === 'flipbook') setShowFlipbook(true);
        } catch (err) {
            console.error('Failed to load all photos for view:', err);
            const fallbackUrls = faces.map(f => f.photo_url.startsWith('http') ? f.photo_url : getPhotoUrl(f.photo_url));
            setAllPhotos(fallbackUrls);
            if (type === 'collage') setShowCollage(true);
            if (type === 'flipbook') setShowFlipbook(true);
        } finally {
            setIsOpeningPremiumView(false);
        }
    };

    const saveClusterName = async (e) => {
        e.preventDefault();
        if (!newName.trim() || newName.trim() === cluster.cluster_name) {
            setIsEditing(false);
            return;
        }
        try {
            const result = await updateClusterName(clusterId, newName.trim());
            if (result.status === 'success') {
                setCluster({ ...cluster, cluster_name: newName.trim() });
                addToast('Profile name updated', 'success');
            }
        } catch (_error) {
            addToast('Failed to update name', 'error');
        } finally {
            setIsEditing(false);
        }
    };

    const handleNextPhoto = useCallback((e) => {
        if (e) e.stopPropagation();
        if (!selectedFace || !displayedFaces.length) return;
        const currentIndex = displayedFaces.findIndex(f => (f.id || f.photo_id) === (selectedFace.id || selectedFace.photo_id));
        const nextIndex = (currentIndex + 1) % displayedFaces.length;
        setSelectedFace(displayedFaces[nextIndex]);
    }, [selectedFace, displayedFaces]);

    const handlePrevPhoto = useCallback((e) => {
        if (e) e.stopPropagation();
        if (!selectedFace || !displayedFaces.length) return;
        const currentIndex = displayedFaces.findIndex(f => (f.id || f.photo_id) === (selectedFace.id || selectedFace.photo_id));
        const prevIndex = (currentIndex - 1 + displayedFaces.length) % displayedFaces.length;
        setSelectedFace(displayedFaces[prevIndex]);
    }, [selectedFace, displayedFaces]);

    useEffect(() => {
        const handleKeyDown = (e) => {
            if (!selectedFace) return;
            if (e.key === 'ArrowRight') handleNextPhoto();
            if (e.key === 'ArrowLeft') handlePrevPhoto();
            if (e.key === 'Escape') setSelectedFace(null);
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [selectedFace, handleNextPhoto, handlePrevPhoto]);



    const handleDownloadAll = async () => {
        if (isDownloading || faces.length === 0) return;
        setIsDownloading(true);
        addToast('Preparing your download zip...', 'info');

        try {
            const isAttendeeMode = clusterId.startsWith('attendee-');
            const isDemoMode = clusterId.startsWith('demo');
            const isRealCluster = !isNaN(parseInt(clusterId)) && !isDemoMode && !isAttendeeMode;

            if (isRealCluster) {
                window.open(`${apiUrl}/clustering/clusters/${clusterId}/download-zip`, '_blank');
            } else if (isAttendeeMode) {
                const photoIds = faces.map(f => f.photo_id).filter(Boolean);
                if (photoIds.length > 0) {
                    const userName = cluster?.cluster_name || 'attendee';
                    const safeName = userName.replace(/[^a-zA-Z0-9]/g, '_');
                    const response = await fetch(`${apiUrl}/attendees/photos/download-zip?filename=${encodeURIComponent(safeName)}`, {
                        method: 'POST',
                        credentials: 'include',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(photoIds)
                    });
                    if (!response.ok) throw new Error('Failed to generate download');
                    const blob = await response.blob();
                    saveAs(blob, `${safeName}_photos.zip`);
                    addToast('Download started', 'success');
                }
            } else {
                const zip = new JSZip();
                const imgFolder = zip.folder('photos');
                await Promise.all(faces.map(async (face, index) => {
                    try {
                        const path = face.photo_url;
                        let url = path.startsWith('http') ? path : getPhotoUrl(path);
                        
                        try {
                            const res = await fetch(url);
                            if (!res.ok) throw new Error('CORS or Network error');
                            const blob = await res.blob();
                            imgFolder.file(`photo_${index + 1}.jpg`, blob);
                        } catch (_fetchErr) {
                            console.warn("Retrying download from S3 for CORS issues", path);
                            // If CloudFront fails due to CORS, try S3 directly which often has proper CORS for downloads
                            try {
                                const s3Url = getPhotoUrl(path, true);
                                const res = await fetch(s3Url);
                                if (!res.ok) throw new Error('S3 also failed');
                                const blob = await res.blob();
                                imgFolder.file(`photo_${index + 1}.jpg`, blob);
                            } catch (_s3Err) {
                                console.error("Final download failure for", path);
                            }
                        }
                    } catch (_e) { }
                }));
                const content = await zip.generateAsync({ type: 'blob' });
                saveAs(content, 'my_photos.zip');
                addToast('Download complete', 'success');
            }
        } catch (_error) {
            addToast('Failed to prepare download', 'error');
        } finally {
            setIsDownloading(false);
        }
    };

    if (loading && !faces.length) {
        return (
            <div style={{ minHeight: '100vh', background: 'linear-gradient(180deg, #fff8f2 0%, #f5f1ec 42%, #f2ede7 100%)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <AILoader active={true} text="RETRIEVING MEMORIES" />
            </div>
        );
    }

    const hasPhotosLoaded = faces.length > 0;

    return (
        <div className="dashboard-themed" style={{ position: 'fixed', inset: 0, zIndex: 40, paddingTop: '76px', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

            {/* Ambient Background Elements */}
            <div style={{ position: 'absolute', inset: 0, zIndex: 0, pointerEvents: 'none' }}>
                <div style={{ position: 'absolute', width: '100%', height: '100%', backgroundImage: 'linear-gradient(rgba(245,130,31,0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(245,130,31,0.06) 1px, transparent 1px)', backgroundSize: '34px 34px', opacity: 0.35, maskImage: 'linear-gradient(180deg, rgba(0,0,0,0.8), transparent 80%)' }} />
                <div style={{
                    position: 'absolute', top: '-10%', left: '-5%', width: '600px', height: '600px',
                    background: 'radial-gradient(circle, rgba(245, 130, 31, 0.10) 0%, transparent 70%)',
                    filter: 'blur(80px)', borderRadius: '50%'
                }} />
            </div>

            {/* Scrollable content area */}
            <div style={{ flex: 1, overflowY: 'auto', position: 'relative', zIndex: 10 }}>
                <main style={{ maxWidth: '1200px', margin: '0 auto', padding: '1.5rem 1.5rem 2rem', position: 'relative' }}>

                    {/* Event Switcher — compact horizontal bar when photos are loaded */}
                    {clusterId?.startsWith('attendee-') && allEvents.length > 0 && (
                        <>
                            {hasPhotosLoaded && !eventsExpanded ? (
                                /* Compact event switcher bar */
                                <div style={{
                                    display: 'flex', alignItems: 'center', gap: '0.75rem',
                                    marginBottom: '1.25rem', padding: '0.6rem 1rem',
                                    background: 'white', border: '1px solid #E2E8F0', borderRadius: '12px',
                                    boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
                                    overflowX: 'auto', flexWrap: 'nowrap'
                                }}>
                                    <span style={{ fontSize: '0.8rem', color: '#94A3B8', fontWeight: 600, whiteSpace: 'nowrap', flexShrink: 0 }}>Events:</span>
                                    <div style={{ display: 'flex', gap: '0.5rem', overflowX: 'auto', flex: 1 }}>
                                        {allEvents.map((event) => {
                                            const isRegistered = !!event.is_registered;
                                            const isActive = String(event.event_id) === String(eventId);
                                            return (
                                                <button
                                                    key={event.event_id}
                                                    onClick={() => {
                                                        if (isRegistered && event.attendee_id) {
                                                            openEventGallery(event);
                                                        } else {
                                                            registerForEvent(event.event_id);
                                                        }
                                                    }}
                                                    style={{
                                                        border: isActive ? '2px solid #f5821f' : '1px solid #E2E8F0',
                                                        borderRadius: '20px',
                                                        padding: '0.35rem 0.85rem',
                                                        fontWeight: 600,
                                                        cursor: 'pointer',
                                                        background: isActive ? '#FFF5EB' : (isRegistered ? '#F8FAFC' : '#F0FDF4'),
                                                        color: isActive ? '#d86d13' : (isRegistered ? '#1f1f1f' : '#0F766E'),
                                                        fontSize: '0.8rem',
                                                        whiteSpace: 'nowrap',
                                                        flexShrink: 0,
                                                        transition: 'all 0.2s'
                                                    }}
                                                >
                                                    {event.event_name}
                                                    {!isRegistered && <span style={{ marginLeft: '4px', fontSize: '0.7rem' }}>↗</span>}
                                                </button>
                                            );
                                        })}
                                    </div>
                                    <button
                                        onClick={() => setEventsExpanded(true)}
                                        style={{
                                            border: 'none', background: 'none', color: '#94A3B8', cursor: 'pointer',
                                            padding: '0.25rem', display: 'flex', alignItems: 'center', flexShrink: 0,
                                            fontSize: '0.75rem', fontWeight: 600, gap: '2px'
                                        }}
                                        title="Expand events view"
                                    >
                                        <ChevronRight size={14} /> Expand
                                    </button>
                                </div>
                            ) : (
                                /* Full events card view */
                                <StandardCard style={{ marginBottom: '1.25rem', padding: '1rem 1.25rem' }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
                                        <h3 style={{ margin: 0, color: '#1f1f1f', fontSize: '1rem', fontWeight: 700 }}>All Events</h3>
                                        {hasPhotosLoaded && (
                                            <button
                                                onClick={() => setEventsExpanded(false)}
                                                style={{
                                                    border: 'none', background: '#F1F5F9', color: '#666666', cursor: 'pointer',
                                                    padding: '0.3rem 0.7rem', borderRadius: '6px', fontSize: '0.75rem', fontWeight: 600,
                                                    display: 'flex', alignItems: 'center', gap: '4px'
                                                }}
                                            >
                                                <X size={12} /> Collapse
                                            </button>
                                        )}
                                    </div>
                                    <div style={{ display: 'grid', gap: '0.5rem' }}>
                                        {allEvents.map((event) => {
                                            const isRegistered = !!event.is_registered;
                                            const isActive = String(event.event_id) === String(eventId);
                                            return (
                                                <div key={event.event_id} style={{
                                                    border: isActive ? '2px solid #f5821f' : '1px solid #E2E8F0',
                                                    borderRadius: '10px', padding: '0.65rem 0.75rem',
                                                    display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.75rem',
                                                    background: isActive ? '#FAFAFE' : 'white',
                                                    transition: 'all 0.2s'
                                                }}>
                                                    <div style={{ minWidth: 0 }}>
                                                        <div style={{ color: '#1f1f1f', fontWeight: 700, fontSize: '0.9rem' }}>{event.event_name}</div>
                                                        <div style={{ color: '#666666', fontSize: '0.8rem', marginTop: '0.15rem' }}>
                                                            {isRegistered
                                                                ? `${event.total_event_photos || 0} photos available`
                                                                : `Status: ${event.event_status || 'active'}`}
                                                        </div>
                                                    </div>
                                                    <button
                                                        onClick={() => {
                                                            if (isRegistered && event.attendee_id) {
                                                                openEventGallery(event);
                                                                if (hasPhotosLoaded) setEventsExpanded(false);
                                                                return;
                                                            }
                                                            registerForEvent(event.event_id);
                                                        }}
                                                        style={{
                                                            border: 'none', borderRadius: '8px',
                                                            padding: '0.4rem 0.75rem', fontWeight: 700,
                                                            cursor: 'pointer', fontSize: '0.8rem', flexShrink: 0,
                                                            background: isActive ? '#F5EDE4' : (isRegistered ? '#f5821f' : '#0F766E'),
                                                            color: isActive ? '#64748B' : '#FFF'
                                                        }}
                                                        disabled={isActive}
                                                    >
                                                        {isActive ? 'Viewing' : (isRegistered ? 'Open Photos' : 'Register')}
                                                    </button>
                                                </div>
                                            );
                                        })}
                                    </div>
                                </StandardCard>
                            )}
                        </>
                    )}

                    {/* Compact Profile + Actions Bar */}
                    <div style={{ marginBottom: '1.25rem' }}>
                        {/* Title row */}
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '1rem' }}>
                            <div style={{ flex: 1, minWidth: '280px' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: '#d86d13', fontWeight: '700', fontSize: '0.75rem', letterSpacing: '0.06em', marginBottom: '0.35rem' }}>
                                    <ImageIcon size={14} /> PERSONAL COLLECTION
                                </div>
                                {isEditing ? (
                                    <form onSubmit={saveClusterName} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                        <input
                                            type="text"
                                            value={newName}
                                            onChange={(e) => setNewName(e.target.value)}
                                            autoFocus
                                            style={{ fontSize: '1.75rem', fontWeight: '800', border: 'none', background: 'transparent', color: '#1f1f1f', borderBottom: '2px solid #f5821f', outline: 'none', maxWidth: '400px' }}
                                        />
                                        <button type="submit" style={{ background: '#ECFDF5', border: 'none', color: '#059669', padding: '0.4rem', borderRadius: '50%', cursor: 'pointer' }}><Check size={18} /></button>
                                        <button onClick={() => setIsEditing(false)} style={{ background: '#FEF2F2', border: 'none', color: '#EF4444', padding: '0.4rem', borderRadius: '50%', cursor: 'pointer' }}><X size={18} /></button>
                                    </form>
                                ) : (
                                    <h1 style={{ fontSize: '1.75rem', fontWeight: '800', color: '#1f1f1f', display: 'flex', alignItems: 'center', gap: '0.5rem', margin: 0 }}>
                                        Welcome, {cluster?.cluster_name || 'Guest'}
                                        <button onClick={() => setIsEditing(true)} style={{ background: 'none', border: 'none', color: '#94A3B8', cursor: 'pointer', padding: '2px' }}><Edit2 size={16} /></button>
                                    </h1>
                                )}
                                <p style={{ color: '#666666', marginTop: '0.25rem', fontSize: '0.9rem', margin: '0.25rem 0 0' }}>We found <strong>{totalFaces} photos</strong> of you from the event.</p>
                            </div>

                            {/* Action buttons — compact row */}
                            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
                                <button
                                    onClick={() => openPremiumView('flipbook')}
                                    disabled={isOpeningPremiumView || faces.length === 0}
                                    style={{
                                        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.4rem',
                                        padding: '0.55rem 0.85rem', background: '#F8FAFC', color: '#1f1f1f',
                                        border: '1px solid rgba(37,30,24,0.08)', borderRadius: '10px', fontWeight: '600',
                                        cursor: (isOpeningPremiumView || faces.length === 0) ? 'not-allowed' : 'pointer', fontSize: '0.85rem',
                                        transition: 'all 0.2s',
                                        opacity: (isOpeningPremiumView || faces.length === 0) ? 0.6 : 1
                                    }}
                                    onMouseEnter={e => { if (!isOpeningPremiumView && faces.length > 0) e.currentTarget.style.background = '#F1F5F9'; }}
                                    onMouseLeave={e => { if (!isOpeningPremiumView && faces.length > 0) e.currentTarget.style.background = '#F8FAFC'; }}
                                >
                                    {isOpeningPremiumView ? <Loader2 size={16} className="animate-spin" color="#6366F1" /> : <BookOpen size={16} color="#10B981" />}
                                    <span className="hide-on-mobile">{isOpeningPremiumView ? 'Loading' : 'Flipbook'}</span>
                                </button>
                                <button
                                    onClick={() => setShowMemories(true)}
                                    style={{
                                        padding: '0.55rem 0.85rem', borderRadius: '10px', border: 'none',
                                        background: 'linear-gradient(135deg, #d86d13 0%, #f5821f 100%)', color: 'white',
                                        fontWeight: '600', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.4rem',
                                        boxShadow: '0 2px 8px rgba(217, 109, 19, 0.25)', fontSize: '0.85rem'
                                    }}
                                >
                                    <Sparkles size={16} /> <span className="hide-on-mobile">Cinematic</span>
                                </button>
                                <button
                                    onClick={() => setShowCollage(true)}
                                    style={{
                                        padding: '0.55rem 0.85rem', borderRadius: '10px', border: '1px solid #E2E8F0',
                                        background: 'white', color: '#666666',
                                        fontWeight: '600', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.85rem'
                                    }}
                                >
                                    <Layout size={16} /> <span className="hide-on-mobile">Collage</span>
                                </button>
                                <button
                                    onClick={handleDownloadAll}
                                    disabled={isDownloading || faces.length === 0}
                                    style={{
                                        padding: '0.55rem 0.85rem', borderRadius: '10px', border: '1px solid #E2E8F0',
                                        background: 'white', color: '#666666',
                                        fontWeight: '600', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.85rem'
                                    }}
                                >
                                    {isDownloading ? <Loader2 size={16} className="spin-slow" /> : <Download size={16} />}
                                    <span className="hide-on-mobile">Download</span>
                                </button>
                            </div>
                        </div>

                        {/* Filter tabs — inline below the title */}
                        <div style={{ marginTop: '0.75rem', display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                            <button
                                onClick={() => setViewMode('all')}
                                style={{
                                    padding: '0.4rem 0.85rem', borderRadius: '8px', fontWeight: '600', cursor: 'pointer',
                                    background: viewMode === 'all' ? '#d86d13' : 'rgba(255,255,255,0.88)',
                                    color: viewMode === 'all' ? 'white' : '#666666',
                                    border: '1px solid rgba(37,30,24,0.08)', fontSize: '0.85rem', transition: 'all 0.2s'
                                }}
                            >
                                All Photos
                            </button>

                            <button
                                onClick={() => setViewMode('highlight')}
                                style={{
                                    padding: '0.4rem 0.85rem', borderRadius: '8px', fontWeight: '600', cursor: 'pointer',
                                    background: viewMode === 'highlight' ? '#d86d13' : 'rgba(255,255,255,0.88)',
                                    color: viewMode === 'highlight' ? 'white' : '#666666',
                                    border: '1px solid rgba(37,30,24,0.08)', fontSize: '0.85rem', transition: 'all 0.2s', display: 'flex', alignItems: 'center', gap: '4px'
                                }}
                            >
                                <Sparkles size={13} color={viewMode === 'highlight' ? '#FBBF24' : '#64748B'} /> Highlights
                            </button>

                            {coAttendees.length > 0 && (
                                <select
                                    value={viewMode === 'with' ? selectedCoAttendee : ''}
                                    onChange={(e) => {
                                        if (e.target.value) {
                                            setSelectedCoAttendee(e.target.value);
                                            setViewMode('with');
                                        } else {
                                            setViewMode('all');
                                            setSelectedCoAttendee('');
                                        }
                                    }}
                                    style={{
                                        padding: '0.4rem 0.85rem', borderRadius: '8px', fontWeight: '600', cursor: 'pointer',
                                        background: viewMode === 'with' ? '#d86d13' : 'rgba(255,255,255,0.88)',
                                        color: viewMode === 'with' ? 'white' : '#666666',
                                        border: '1px solid rgba(37,30,24,0.08)', fontSize: '0.85rem', outline: 'none', transition: 'all 0.2s'
                                    }}
                                >
                                    <option value="">Find Me With...</option>
                                    {coAttendees.map(co => (
                                        <option key={co.cluster_id} value={co.cluster_id}>{co.name}</option>
                                    ))}
                                </select>
                            )}
                        </div>
                    </div>

                    {/* Photo Grid */}
                    {displayedFaces.length === 0 ? (
                        <StandardCard style={{ padding: '3rem', textAlign: 'center' }}>
                            <div style={{ width: '56px', height: '56px', background: '#F1F5F9', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 1rem', color: '#94A3B8' }}>
                                <ImageIcon size={28} />
                            </div>
                            <h3 style={{ fontSize: '1.15rem', fontWeight: '700', color: '#1f1f1f', marginBottom: '0.5rem' }}>No Photos Found</h3>
                            <p style={{ color: '#666666', maxWidth: '400px', margin: '0 auto' }}>
                                {viewMode === 'highlight' ? "We couldn't generate a highlight reel yet." :
                                 viewMode === 'with' ? "No photos found with this person." :
                                 "Your photos will automatically appear here as they are processed by our AI system."}
                            </p>
                        </StandardCard>
                    ) : (
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '1rem' }}>
                            {displayedFaces.map((face, idx) => (
                                <motion.div
                                    key={`${face.id || idx}-${face.photo_url}`}
                                    whileHover={{ y: -4 }}
                                    style={{ cursor: 'pointer' }}
                                    onClick={() => setSelectedFace(face)}
                                >
                                    <StandardCard style={{ height: '280px', position: 'relative' }}>
                                        <img
                                            src={face.photo_url.startsWith('http') ? face.photo_url : getPhotoUrl(face.photo_url)}
                                            alt="Memory"
                                            loading="lazy"
                                            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                                        />
                                        <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(to top, rgba(0,0,0,0.35), transparent 45%)', opacity: 0.8 }} />
                                        <div style={{ position: 'absolute', bottom: '0.75rem', right: '0.75rem', color: 'white' }}>
                                            <Play size={14} style={{ opacity: 0.6 }} />
                                        </div>
                                        {viewMode === 'highlight' && face.quality_score && (
                                            <div style={{ position: 'absolute', top: '0.75rem', left: '0.75rem', background: 'rgba(0,0,0,0.6)', color: '#FBBF24', padding: '0.15rem 0.45rem', borderRadius: '12px', fontSize: '0.7rem', fontWeight: 'bold' }}>
                                                {(face.quality_score * 100).toFixed(0)}% Score
                                            </div>
                                        )}
                                    </StandardCard>
                                </motion.div>
                            ))}
                        </div>
                    )}
                </main>
            </div>

            {/* Lightbox */}
            <AnimatePresence>
                {selectedFace && (
                    <motion.div
                        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                        style={{ position: 'fixed', inset: 0, background: 'rgba(15, 23, 42, 0.9)', backdropFilter: 'blur(8px)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '2rem' }}
                        onClick={() => setSelectedFace(null)}
                    >
                        <motion.div
                            initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
                            style={{ position: 'relative', maxWidth: '1000px', width: '100%', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center' }}
                            onClick={e => e.stopPropagation()}
                        >
                            {/* Navigation Buttons */}
                            <button
                                onClick={handlePrevPhoto}
                                style={{
                                    position: 'fixed', left: '2rem', top: '50%', transform: 'translateY(-50%)',
                                    background: 'rgba(255,255,255,0.1)', border: 'none', borderRadius: '50%',
                                    padding: '1rem', color: 'white', cursor: 'pointer', backdropFilter: 'blur(4px)',
                                    transition: 'all 0.2s', zIndex: 110, display: 'flex', alignItems: 'center', justifyContent: 'center'
                                }}
                                onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.2)'}
                                onMouseLeave={e => e.currentTarget.style.background = 'rgba(255,255,255,0.1)'}
                            >
                                <ChevronLeft size={36} />
                            </button>

                            <button
                                onClick={handleNextPhoto}
                                style={{
                                    position: 'fixed', right: '2rem', top: '50%', transform: 'translateY(-50%)',
                                    background: 'rgba(255,255,255,0.1)', border: 'none', borderRadius: '50%',
                                    padding: '1rem', color: 'white', cursor: 'pointer', backdropFilter: 'blur(4px)',
                                    transition: 'all 0.2s', zIndex: 110, display: 'flex', alignItems: 'center', justifyContent: 'center'
                                }}
                                onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.2)'}
                                onMouseLeave={e => e.currentTarget.style.background = 'rgba(255,255,255,0.1)'}
                            >
                                <ChevronRight size={36} />
                            </button>

                            <img
                                src={selectedFace.photo_url.startsWith('http') ? selectedFace.photo_url : getPhotoUrl(selectedFace.photo_url)}
                                style={{ maxWidth: '100%', maxHeight: '80vh', borderRadius: '12px', boxShadow: '0 25px 50px -12px rgba(0,0,0,0.5)', objectFit: 'contain' }}
                            />
                            <div style={{ marginTop: '1.5rem', display: 'flex', justifyContent: 'center', gap: '1rem' }}>
                                <button
                                    onClick={() => setSelectedFace(null)}
                                    style={{ background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.2)', color: 'white', padding: '0.75rem 1.5rem', borderRadius: '8px', cursor: 'pointer' }}
                                >
                                    Close
                                </button>
                                <a
                                    href={selectedFace.photo_url.startsWith('http') ? selectedFace.photo_url : getPhotoUrl(selectedFace.photo_url)}
                                    download target="_blank" rel="noopener noreferrer"
                                    style={{ background: 'white', color: '#1f1f1f', padding: '0.75rem 1.5rem', borderRadius: '8px', fontWeight: '700', textDecoration: 'none', display: 'flex', alignItems: 'center', gap: '0.5rem' }}
                                >
                                    <Download size={18} /> Download
                                </a>
                            </div>
                        </motion.div>
                    </motion.div>
                )}
            </AnimatePresence>

            {/* Cinematic Modal */}
            {showMemories && (
                <div style={{
                    position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
                    background: 'rgba(0, 0, 0, 0.85)', zIndex: 100,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    backdropFilter: 'blur(8px)',
                    padding: '2rem'
                }} onClick={() => setShowMemories(false)}>
                    <div
                        style={{
                            position: 'relative',
                            width: '100%',
                            maxWidth: '1000px',
                            aspectRatio: '16/9',
                            background: '#000',
                            borderRadius: '16px',
                            overflow: 'hidden',
                            boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)'
                        }}
                        onClick={e => e.stopPropagation()}
                    >
                        <CinematicManager
                            initialPhotos={displayedFaces.map(f => f.photo_url.startsWith('http') ? f.photo_url : getPhotoUrl(f.photo_url))}
                            onClose={() => setShowMemories(false)}
                            mode="modal"
                            eventName={cluster?.event_name || cluster?.cluster_name || "Event Memory"}
                        />
                    </div>
                </div>
            )}

            {/* Collage Modal */}
            {showCollage && (
                <CollageManager
                    initialPhotos={allPhotos || faces.map(f => f.photo_url.startsWith('http') ? f.photo_url : getPhotoUrl(f.photo_url))}
                    onClose={() => setShowCollage(false)}
                    backLabel="Back to Dashboard"
                />
            )}

            {/* Flipbook Modal */}
            {showFlipbook && (
                <FlipbookManager
                    initialPhotos={allPhotos || faces.map(f => f.photo_url.startsWith('http') ? f.photo_url : getPhotoUrl(f.photo_url))}
                    onClose={() => setShowFlipbook(false)}
                    backLabel="Back to Dashboard"
                    eventName={cluster?.event_name || cluster?.cluster_name || "Event Photos"}
                />
            )}

            <style>{`
                 @keyframes spin-slow { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
                 .spin-slow { animation: spin-slow 2s linear infinite; }
                 @media (max-width: 640px) {
                     .hide-on-mobile { display: none !important; }
                 }
            `}</style>
        </div>
    );
};

export default AttendeeDashboard;
