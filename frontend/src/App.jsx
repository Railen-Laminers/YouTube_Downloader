import React, { useState, useEffect, lazy, Suspense } from 'react';
import { Search, Music, AlertCircle } from 'lucide-react';
const VideoCard = lazy(() => import('./VideoCard'));

// Helper: safely produce a base API URL
// Dev (vite) => use relative '/api' so Vite proxy handles it
// Prod => use VITE_API_URL if provided (should include /api), otherwise fallback to localhost
const isDev = Boolean(import.meta.env.DEV);
const rawProdApi = (import.meta.env.VITE_API_URL || 'http://localhost:5000/api').toString().trim();

// ensure no trailing slash for the base (we'll append segments safely)
const prodApiBase = rawProdApi.replace(/\/$/, '');

// final API base used by code:
const API_BASE = isDev ? '/api' : prodApiBase; // in dev, use relative path so proxy works

// safe join function so `${API_BASE}/search` never becomes invalid
function joinApi(path) {
  // path may already include query string, e.g. '/search?query=foo'
  return `${API_BASE.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
}

function parseContentDisposition(headerValue) {
  if (!headerValue) return null;
  const fnStar = headerValue.match(/filename\*\s*=\s*([^']+?)''([^;]+)/i);
  if (fnStar) {
    try { return decodeURIComponent(fnStar[2]); } catch { return fnStar[2]; }
  }
  const fn = headerValue.match(/filename="?(.+?)"?(\s*;|$)/i);
  if (fn) {
    try { return decodeURIComponent(fn[1]); } catch { return fn[1]; }
  }
  return null;
}

function App() {
  const [query, setQuery] = useState('');
  const [videos, setVideos] = useState([]);
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState({}); // key -> {progress, size, downloading}
  const [error, setError] = useState('');
  const [healthStatus, setHealthStatus] = useState(null);

  useEffect(() => { checkHealth(); }, []);

  const fetchWithTimeout = async (url, options = {}, timeout = 15000) => {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      return res;
    } catch (err) {
      if (err.name === 'AbortError') throw new Error('Request timed out. Your network may be slow.');
      throw err;
    } finally {
      clearTimeout(id);
    }
  };

  const checkHealth = async () => {
    try {
      const response = await fetchWithTimeout(joinApi('/health'), {}, 7000);
      if (response.ok) {
        const data = await response.json().catch(() => null);
        setHealthStatus(data || { status: 'OK' });
      } else {
        setHealthStatus({ status: 'DOWN' });
      }
    } catch (err) {
      setHealthStatus({ status: 'UNKNOWN' });
      console.warn('Health check failed:', err.message || err);
    }
  };

  const searchVideos = async (e) => {
    e?.preventDefault();
    if (!query.trim()) return;
    setLoading(true); setError(''); setVideos([]);
    try {
      const response = await fetchWithTimeout(joinApi(`/search?query=${encodeURIComponent(query)}`), {}, 15000);
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error((data && data.error) ? data.error : `Search failed (${response.status})`);
      if (!data || !Array.isArray(data)) throw new Error('Unexpected response from server.');
      setVideos(data);
    } catch (err) {
      setError(err.message || 'Failed to search videos. Please try again.');
      console.error('Search error:', err);
    } finally {
      setLoading(false);
    }
  };

  // Stream-download, supports progress (if Content-Length present)
  const downloadFile = async (videoId, title, format) => {
    const key = `${videoId}_${format}`;
    setDownloading(prev => ({ ...prev, [key]: { downloading: true, progress: 0, size: null } }));
    setError('');

    const controller = new AbortController();
    // generous timeout (8 minutes) for large downloads
    const timeoutId = setTimeout(() => controller.abort(), 8 * 60 * 1000);

    try {
      const response = await fetch(joinApi(`/download/${videoId}?format=${format}`), {
        method: 'GET',
        mode: 'cors',
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.error || `Download failed (${response.status})`);
      }

      // filename from header (supports urlencoded and RFC5987)
      const cd = response.headers.get('Content-Disposition');
      let filename = parseContentDisposition(cd) || `${title.replace(/[^\w\s.-]/gi, '').substring(0, 50)}.${format}`;

      // Read stream and build blob incrementally to show progress
      const contentLength = response.headers.get('Content-Length');
      const total = contentLength ? parseInt(contentLength, 10) : null;
      if (total) {
        setDownloading(prev => ({ ...prev, [key]: { ...prev[key], size: total } }));
      }

      const reader = response.body.getReader();
      const chunks = [];
      let received = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        setDownloading(prev => ({ ...prev, [key]: { ...prev[key], downloading: true, progress: total ? Math.floor((received / total) * 100) : null, size: total } }));
      }

      // Combine and save
      const blob = new Blob(chunks, { type: response.headers.get('Content-Type') || (format === 'mp3' ? 'audio/mpeg' : 'video/mp4') });
      if (!blob || blob.size === 0) throw new Error('Empty file received');

      const objectUrl = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => window.URL.revokeObjectURL(objectUrl), 1500);
      console.log(`Downloaded ${filename} (${blob.size} bytes)`);
    } catch (err) {
      clearTimeout(timeoutId);
      if (err.name === 'AbortError' || (err.message && err.message.toLowerCase().includes('timed out'))) {
        setError('Download timeout or aborted. The file might be large or your network is slow.');
      } else {
        setError(err.message || 'Failed to download. Please try again.');
      }
      console.error('Download error:', err);
    } finally {
      setDownloading(prev => {
        const copy = { ...prev };
        delete copy[key];
        return copy;
      });
    }
  };

  const formatDuration = (seconds) => {
    if (!seconds) return '0:00';
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    if (hrs > 0) return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    return `${mins}:${String(secs).padStart(2, '0')}`;
  };

  const formatViews = (views) => {
    if (!views && views !== 0) return '0 views';
    if (views >= 1000000) return `${(views / 1000000).toFixed(1)}M views`;
    if (views >= 1000) return `${(views / 1000).toFixed(1)}K views`;
    return `${views} views`;
  };

  const SkeletonCard = () => (
    <div className="skeleton-card">
      <div className="skel-thumb shimmer"></div>
      <div className="skel-body">
        <div className="skel-line full shimmer"></div>
        <div className="skel-line mid shimmer"></div>
        <div className="skel-line short shimmer" style={{ marginTop: 8 }}></div>
      </div>
    </div>
  );

  return (
    <div className="app">
      <header className="header">
        <div className="logo">
          <Music size={32} />
          <div>
            <h1>YouTube Downloader</h1>
            <small>For educational purposes only</small>
          </div>
        </div>

        <div className="health-status" title="Server health">
          <div className={`status-dot ${healthStatus && healthStatus.status === 'OK' ? 'online' : (healthStatus && healthStatus.status === 'DOWN' ? 'offline' : '')}`}></div>
        </div>
      </header>

      <main className="main">
        <form onSubmit={searchVideos} className="search-form" role="search" aria-label="Search videos">
          <div className="search-input">
            <Search size={18} />
            <input
              type="text" value={query} onChange={(e) => setQuery(e.target.value)}
              placeholder="Search YouTube videos..." disabled={loading} autoFocus aria-label="Search query"
            />
            {query && <button type="button" className="clear-btn" onClick={() => { setQuery(''); setVideos([]); }}>×</button>}
          </div>

          <button type="submit" disabled={loading || !query.trim()} className="search-btn">
            {loading ? 'Searching...' : 'Search'}
          </button>
        </form>

        {error && (
          <div className="error-message" role="alert">
            <AlertCircle size={18} />
            <span>{error}</span>
            <button className="close-error" onClick={() => setError('')}>×</button>
          </div>
        )}

        {videos.length > 0 && (
          <div className="results-info">
            <p>Found {videos.length} video{videos.length !== 1 ? 's' : ''}</p>
            <button className="clear-results" onClick={() => setVideos([])}>Clear Results</button>
          </div>
        )}

        <div className="video-grid" aria-live="polite">
          {videos.map(video => (
            <Suspense key={video.id} fallback={<SkeletonCard />}>
              <VideoCard
                video={video}
                downloading={downloading}
                downloadFile={downloadFile}
                formatDuration={formatDuration}
                formatViews={formatViews}
              />
            </Suspense>
          ))}
        </div>

        {videos.length === 0 && !loading && (
          <div className="empty-state">
            <Music size={64} />
            <p>Search for YouTube videos to download</p>
            <small>Enter a search term above to get started</small>
          </div>
        )}

        {loading && (
          <div className="loading-state" aria-live="polite">
            <div className="spinner-large" role="status" />
            <p>Searching YouTube...</p>
          </div>
        )}
      </main>

      <footer className="footer">
        <div className="footer-content">
          <p>⚠️ Educational Purpose Only | Respect Copyright Laws</p>
          <p style={{ marginTop: 8 }} className="small">© {new Date().getFullYear()} YouTube Downloader. Not affiliated with YouTube.</p>
        </div>
      </footer>
    </div>
  );
}

export default App;
