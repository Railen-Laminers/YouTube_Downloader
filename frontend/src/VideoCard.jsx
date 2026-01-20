import React from 'react';
import { Clock, User, Download } from 'lucide-react';

export default function VideoCard({ video, downloading = {}, downloadFile, formatDuration, formatViews }) {
    const mp4Key = `${video.id}_mp4`;
    const mp3Key = `${video.id}_mp3`;
    const mp4State = downloading[mp4Key];
    const mp3State = downloading[mp3Key];

    return (
        <article className="bg-white rounded-xl overflow-hidden shadow-card flex flex-col min-h-[260px]" role="article" aria-label={video.title}>
            {/* Thumbnail */}
            <div className="relative w-full pt-[56.25%] bg-indigo-50 overflow-hidden">
                {video.thumbnail && (
                    <img
                        src={video.thumbnail}
                        alt={video.title || 'video thumbnail'}
                        loading="lazy"
                        className="absolute inset-0 w-full h-full object-cover"
                    />
                )}
                {/* Duration */}
                <div className="absolute bottom-2 right-2 inline-flex items-center gap-2 bg-black bg-opacity-70 text-white px-2 py-1 text-xs rounded">
                    <span className="sr-only">Duration</span>
                    <Clock size={12} />
                    <span>{formatDuration(video.duration)}</span>
                </div>
            </div>

            {/* Content */}
            <div className="p-3 flex flex-col gap-2 flex-1">
                {/* Title */}
                <h3 className="text-sm leading-tight m-0 text-gray-900 font-medium" title={video.title}>
                    {video.title && video.title.length > 80 ? `${video.title.substring(0, 80)}…` : video.title}
                </h3>

                {/* Channel & Views */}
                <div className="flex items-center justify-between text-sm text-gray-500">
                    <div className="flex items-center gap-2">
                        <User size={14} className="text-gray-400" />
                        <span className="text-xs text-gray-400">{video.channel || video.channelTitle || 'Unknown'}</span>
                    </div>
                    <div className="text-xs text-gray-400">{formatViews(video.views)}</div>
                </div>

                {/* Description */}
                <p className="text-sm text-gray-600 mt-1 mb-2 overflow-hidden max-h-[4.2em]">
                    {video.description ? (video.description.length > 140 ? `${video.description.substring(0, 140)}…` : video.description) : 'No description available'}
                </p>

                {/* Download Buttons */}
                <div className="flex items-center gap-2 mt-auto">
                    <button
                        className={`flex-1 px-3 py-2 rounded-md text-sm text-white flex justify-center items-center gap-1 ${mp4State ? 'bg-gray-600' : 'bg-emerald-500'}`}
                        onClick={() => downloadFile(video.id, video.title || 'video', 'mp4')}
                        disabled={!!mp4State}
                        aria-disabled={!!mp4State}
                        aria-label={`Download ${video.title} as MP4`}
                    >
                        {mp4State
                            ? (mp4State.progress != null ? `Downloading ${mp4State.progress}%` : (mp4State.status || 'Preparing...'))
                            : (<><Download size={14} /> MP4</>)
                        }
                    </button>

                    <button
                        className={`flex-1 px-3 py-2 rounded-md text-sm text-white flex justify-center items-center gap-1 ${mp3State ? 'bg-gray-600' : 'bg-slate-800'}`}
                        onClick={() => downloadFile(video.id, video.title || 'audio', 'mp3')}
                        disabled={!!mp3State}
                        aria-disabled={!!mp3State}
                        aria-label={`Download ${video.title} as MP3`}
                    >
                        {mp3State
                            ? (mp3State.progress != null ? `Downloading ${mp3State.progress}%` : (mp3State.status || 'Preparing...'))
                            : (<><Download size={14} /> MP3</>)
                        }
                    </button>
                </div>

                {/* Progress Bar */}
                {(mp4State?.progress != null || mp3State?.progress != null) && (
                    <div className="mt-2">
                        <div className="w-full bg-slate-100 rounded-full h-2 overflow-hidden">
                            <div
                                className="h-2 bg-blue-600"
                                style={{ width: `${mp4State?.progress || mp3State?.progress || 0}%` }}
                            />
                        </div>
                    </div>
                )}
            </div>
        </article>
    );
}
