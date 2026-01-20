import React, { useState, useEffect, lazy, Suspense } from 'react';
import { Search, Music, AlertCircle } from 'lucide-react';
const VideoCard = lazy(() => import('./VideoCard'));

// Helper: safely produce a base API URL
const isDev = Boolean(import.meta.env.DEV);
const rawProdApi = (import.meta.env.VITE_API_URL || 'http://localhost:5000/api').toString().trim();
const prodApiBase = rawProdApi.replace(/\/$/, '');
const API_BASE = isDev ? '/api' : prodApiBase;

function joinApi(path) {
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
  const [downloading, setDownloading] = useState({}); // key -> {progress, size, downloading, status}
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

  // NEW: Stream-download with SSE progress (works for mp4 and mp3)
  const downloadFile = async (videoId, title, format) => {
    const key = `${videoId}_${format}`;
    setDownloading(prev => ({ ...prev, [key]: { downloading: true, progress: 0, size: null, status: 'starting' } }));
    setError('');

    // Open SSE progress channel
    let es;
    try {
      es = new EventSource(joinApi(`/progress/${encodeURIComponent(key)}`));
      es.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data);
          setDownloading(prev => ({ ...prev, [key]: { ...prev[key], ...data } }));
        } catch (e) {
          // ignore parse errors
        }
      };
      es.onerror = (e) => {
        // SSE might error silently; don't treat as fatal — we'll still stream response bytes
        console.warn('SSE error', e);
      };
    } catch (e) {
      console.warn('Could not open progress EventSource', e);
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8 * 60 * 1000);

    try {
      // include key so server links ffmpeg -> SSE emitter
      const url = joinApi(`/download/${videoId}?format=${format}&key=${encodeURIComponent(key)}`);
      const response = await fetch(url, {
        method: 'GET',
        mode: 'cors',
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.error || `Download failed (${response.status})`);
      }

      // get Content-Length for mp4 case
      const contentLength = response.headers.get('Content-Length');
      const total = contentLength ? parseInt(contentLength, 10) : null;
      if (total) {
        setDownloading(prev => ({ ...prev, [key]: { ...prev[key], size: total } }));
      }

      // read response stream (we still need to assemble blob client-side)
      const reader = response.body.getReader();
      const chunks = [];
      let received = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        // only update progress by bytes if we have a total; otherwise SSE will update progress
        setDownloading(prev => ({ ...prev, [key]: { ...prev[key], downloading: true, progress: total ? Math.floor((received / total) * 100) : prev[key]?.progress } }));
      }

      const blob = new Blob(chunks, { type: response.headers.get('Content-Type') || (format === 'mp3' ? 'audio/mpeg' : 'video/mp4') });
      if (!blob || blob.size === 0) throw new Error('Empty file received');

      // derive filename from header (fallback to sanitized title)
      let filename = parseContentDisposition(response.headers.get('Content-Disposition')) || `${title.replace(/[^\w\s.-]/gi, '').substring(0, 50)}.${format}`;
      try { filename = decodeURIComponent(filename); } catch (_) { }

      const objectUrl = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => window.URL.revokeObjectURL(objectUrl), 1500);

      // ensure UI shows 100%
      setDownloading(prev => ({ ...prev, [key]: { ...prev[key], progress: 100, status: 'done' } }));
    } catch (err) {
      clearTimeout(timeoutId);
      if (err.name === 'AbortError' || (err.message && err.message.toLowerCase().includes('timed out'))) {
        setError('Download timeout or aborted. The file might be large or your network is slow.');
      } else {
        setError(err.message || 'Failed to download. Please try again.');
      }
      console.error('Download error:', err);
    } finally {
      // close SSE
      try { if (es) es.close(); } catch (_) { }
      // remove downloading state after a short delay so UI can show "Done" briefly
      setTimeout(() => {
        setDownloading(prev => {
          const copy = { ...prev };
          delete copy[key];
          return copy;
        });
      }, 1500);
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
    if (views >= 1000) return `${(views / 1000).toFixed(2)}K views`;
    return `${views} views`;
  };

  const SkeletonCard = () => (
    <div className="rounded-xl bg-white overflow-hidden shadow-card">
      <div className="w-full pt-[56.25%] bg-indigo-50 animate-shimmer bg-[length:400%_100%]"></div>
      <div className="p-3">
        <div className="h-3 rounded-md bg-slate-100 mb-2 w-full animate-shimmer"></div>
        <div className="h-3 rounded-md bg-slate-100 mb-2 w-[70%] animate-shimmer"></div>
        <div className="h-3 rounded-md bg-slate-100 w-[40%] animate-shimmer" style={{ marginTop: 8 }}></div>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-[#f6f7fb] text-[#222] font-sans antialiased">
      <div className="max-w-[1100px] mx-auto mt-5 p-[18px]">
        <header className="flex items-center justify-between mb-4">
          <div className="flex gap-3 items-center">
            <Music size={32} />
            <div>
              <h1 className="text-lg m-0 font-medium">YouTube Downloader</h1>
            </div>
          </div>

          <div className="flex gap-2 items-center text-gray-700 text-sm" title="Server health">
            <div className={
              `w-2.5 h-2.5 rounded-full ${healthStatus && healthStatus.status === 'OK' ? 'bg-emerald-500' :
                (healthStatus && healthStatus.status === 'DOWN' ? 'bg-red-500' : 'bg-gray-300')
              }`
            } />
          </div>
        </header>

        <main>
          <form onSubmit={searchVideos} className="flex gap-2 mb-4" role="search" aria-label="Search videos">
            <div className="flex items-center gap-2 flex-1 bg-white rounded-md px-3 py-2 border border-gray-200 min-h-[44px]">
              <Search size={18} className="text-gray-400" />
              <input
                className="outline-none border-0 w-full text-sm"
                type="text" value={query} onChange={(e) => setQuery(e.target.value)}
                placeholder="Search YouTube videos..." disabled={loading} autoFocus aria-label="Search query"
              />
              {query && <button type="button" className="bg-transparent border-0 text-lg cursor-pointer text-gray-400" onClick={() => { setQuery(''); setVideos([]); }}>×</button>}
            </div>

            <button
              type="submit"
              disabled={loading || !query.trim()}
              className="min-w-[120px] bg-blue-600 text-white border-0 rounded-md px-4 py-2 cursor-pointer font-semibold disabled:bg-blue-200 disabled:cursor-not-allowed"
            >
              {loading ? 'Searching...' : 'Search'}
            </button>
          </form>

          {error && (
            <div className="flex items-center gap-3 bg-red-50 text-red-700 p-3 rounded-md border border-red-200 mb-3" role="alert">
              <AlertCircle size={18} />
              <span className="flex-1">{error}</span>
              <button className="bg-transparent border-0 cursor-pointer text-lg" onClick={() => setError('')}>×</button>
            </div>
          )}

          {videos.length > 0 && (
            <div className="flex justify-between items-center my-2 text-gray-700 text-sm">
              <p>Found {videos.length} video{videos.length !== 1 ? 's' : ''}</p>
              <button className="bg-transparent border border-gray-200 px-2 py-1 rounded-sm cursor-pointer" onClick={() => setVideos([])}>Clear Results</button>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4" aria-live="polite">
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
            <div className="text-center py-8 text-gray-600">
              <Music size={64} />
              <p className="mt-4">Search for YouTube videos to download</p>
              <small className="block mt-2 text-sm text-gray-500">Enter a search term above to get started</small>
            </div>
          )}

          {loading && (
            <div className="text-center py-8 text-gray-600" aria-live="polite">
              <div className="w-11 h-11 rounded-full border-4 border-slate-100 border-t-blue-600 animate-spin mx-auto mb-3" role="status" />
              <p>Searching YouTube...</p>
            </div>
          )}
        </main>

        <footer className="mt-6 text-center text-gray-500 text-sm">
          <div>
            <p className="mt-2 text-sm text-gray-500">© {new Date().getFullYear()} YouTube Downloader. Not affiliated with YouTube.</p>
          </div>
        </footer>
      </div>
    </div>
  );
}

export default App;
