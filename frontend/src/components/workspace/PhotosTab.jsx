import React, { useEffect, useState, useCallback } from 'react';
import { Image as ImageIcon, X } from 'lucide-react';
import AILoader from '../ui/AILoader';
import { getPhotoUrl } from '../../utils/photoClusteringApi';
import { photoAPI } from '../../services/api';

const formatBytes = (bytes) => {
  const n = Number(bytes) || 0;
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
};

/**
 * Photos tab: event photo gallery with a preview modal.
 */
const PhotosTab = ({ eventId, refreshKey }) => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [preview, setPreview] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const payload = await photoAPI.getEventPhotos(eventId, 120, 0);
      setData(payload);
    } catch (err) {
      setError(err.message || 'Failed to load photos');
    } finally {
      setLoading(false);
    }
  }, [eventId]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1.25rem' }}>
        <h3 className="ws-section-title" style={{ margin: 0 }}>Gallery</h3>
        <span
          style={{
            background: '#eef0f3',
            color: 'var(--ws-text-muted)',
            borderRadius: '999px',
            padding: '0 0.45rem',
            fontSize: '0.7rem',
            fontWeight: 700,
          }}
        >
          {data?.total ?? 0}
        </span>
      </div>

      {loading ? (
        <div style={{ minHeight: 240, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <AILoader active text="LOADING PHOTOS" />
        </div>
      ) : error ? (
        <div className="ws-card" style={{ padding: '2rem', color: 'var(--ws-text-muted)', textAlign: 'center' }}>
          <ImageIcon size={36} style={{ opacity: 0.35, marginBottom: '0.75rem' }} />
          <p style={{ margin: 0, fontWeight: 600 }}>{error}</p>
          <button className="ws-btn" style={{ marginTop: '1rem' }} onClick={load}>Retry</button>
        </div>
      ) : !data?.photos?.length ? (
        <div className="ws-card" style={{ padding: '3rem 1.5rem', textAlign: 'center', color: 'var(--ws-text-muted)' }}>
          <ImageIcon size={40} style={{ opacity: 0.3, marginBottom: '0.75rem' }} />
          <p style={{ fontWeight: 700, margin: '0 0 0.35rem' }}>No photos yet</p>
          <p style={{ fontSize: '0.85rem', margin: 0 }}>Upload photos to populate the gallery.</p>
        </div>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))',
            gap: '0.9rem',
          }}
        >
          {data.photos.map((photo) => (
            <button
              key={photo.id}
              onClick={() => setPreview(photo)}
              aria-label={`Preview photo ${photo.original_filename || photo.id}`}
              style={{
                position: 'relative',
                border: '1px solid var(--ws-border)',
                borderRadius: 'var(--ws-radius)',
                overflow: 'hidden',
                background: '#f1f2f4',
                padding: 0,
                cursor: 'pointer',
              }}
            >
              <img
                src={getPhotoUrl(photo.file_path, false, photo.storage_type)}
                alt={photo.original_filename || `Photo ${photo.id}`}
                loading="lazy"
                style={{ width: '100%', aspectRatio: '1', objectFit: 'cover', display: 'block' }}
                onError={(e) => { e.currentTarget.style.opacity = 0.25; }}
              />
            </button>
          ))}
        </div>
      )}

      {/* Preview modal */}
      {preview && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Photo preview"
          onMouseDown={(e) => { if (e.target === e.currentTarget) setPreview(null); }}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(17, 24, 39, 0.65)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 300,
            padding: '1.5rem',
          }}
        >
          <div
            className="ws-card"
            style={{ maxWidth: '880px', width: '100%', maxHeight: '90vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
          >
            <div style={{ padding: '1rem 1.25rem', borderBottom: '1px solid var(--ws-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem' }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: '0.95rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {preview.original_filename || `Photo #${preview.id}`}
                </div>
                <div style={{ fontSize: '0.75rem', color: 'var(--ws-text-muted)', marginTop: '0.2rem' }}>
                  {formatBytes(preview.file_size)}
                </div>
              </div>
              <button className="ws-btn ws-btn--ghost" aria-label="Close preview" onClick={() => setPreview(null)}>
                <X size={18} />
              </button>
            </div>
            <div style={{ flex: 1, overflow: 'auto', background: '#111827', display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 300 }}>
              <img
                src={getPhotoUrl(preview.file_path, false, preview.storage_type)}
                alt={preview.original_filename || `Photo ${preview.id}`}
                style={{ maxWidth: '100%', maxHeight: '70vh', objectFit: 'contain' }}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default PhotosTab;
