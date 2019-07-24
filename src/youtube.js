const fs = require("fs");
const path = require("path");

const moment = require("moment");
var momentDurationFormatSetup = require("moment-duration-format");
momentDurationFormatSetup(moment);

const ytdl = require("ytdl-core");
const ffmpeg = require("fluent-ffmpeg");

const { google } = require("googleapis");
const youtube = google.youtube("v3");

function youtubeDurationToFf(duration) {
    if (duration) {
        return moment.duration(duration).format("hh:mm:ss");
    }
    return "";
}

function safeFilename(oFilaname) {
    return oFilaname.replace(/[^a-z0-9]/gi, '_').toLowerCase();
}

let LOCAL_CREDENTIALS;

const YOUTUBE = (args) => {
    const { CREDENTIALS, ffmpegPaths } = args;
    if (CREDENTIALS) {
        LOCAL_CREDENTIALS = CREDENTIALS;
    }
    if (ffmpegPaths) {
        const { linuxPath, windowsPath } = ffmpegPaths;
        if (process.platform === "linux" && linuxPath) {
            ffmpeg.setFfmpegPath(linuxPath);
        } else if (process.platform === "win32" && windowsPath) {
            ffmpeg.setFfmpegPath(windowsPath);
        }
    }
    return {
        getVideosInfo: (args) => {
            const { ids } = args;
            let videos = [];
            return new Promise((resolve, reject) => {
                if (ids && ids.length) {
                    let idChain = "";
                    ids.forEach((id, index) => {
                        idChain += id
                        if (index < ids.length - 1) {
                            idChain += ",";
                        }
                    });
                    youtube.videos.list({
                        key: LOCAL_CREDENTIALS.apiKey,
                        part: "snippet, contentDetails, id",
                        id: idChain
                    }, (err, result) => {
                        if (err) {
                            reject(err);
                        } else {
                            const data = result.data;
                            if (data && data.items && data.items.length) {
                                videos = data.items.map(item => {
                                    let thumbnails = item.snippet.thumbnails;
                                    let url = new URL("https://www.youtube.com/watch");
                                    url.searchParams.append("v", item.id);
                                    return {
                                        title: item.snippet.title,
                                        video_url: url.href,
                                        thumbnail_url: thumbnails ? thumbnails.high.url : "",
                                        duration: youtubeDurationToFf(item.contentDetails.duration)
                                    };
                                });
                            }
                            resolve(videos);
                        }
                    });
                } else {
                    reject("ID not found");
                }
            });
        },
        getPlaylist: (args) => {
            const {id} = args;
            return new Promise((resolve, reject) => {
                if (id) {
                    youtube.playlistItems.list({
                        key: LOCAL_CREDENTIALS.apiKey,
                        part: "snippet",
                        playlistId: id,
                        maxResults: 50
                    }, (err, response) => {
                        if (err) {
                            reject(err);
                        } else {
                            if (response.data && response.data.items) {
                                YOUTUBE.getVideosInfo({
                                    ids: response.data.items.map(item => item.snippet.resourceId.videoId)
                                }).then(resolve).catch(reject);
                            }
                        }
                    });
                } else {
                    reject("ID not defined");
                }
        
            });
        },
        getByText: (args) => {
            const { text } = args;
            return new Promise((resolve, reject) => {
                if (text) {
                    youtube.search.list({
                        key: LOCAL_CREDENTIALS.apiKey,
                        part: "id",
                        q: text,
                        maxResults: 50
                    }, (err, response) => {
                        if (err) {
                            reject(err);
                        } else {
                            if (response.data && response.data.items) {
                                YOUTUBE.getVideosInfo({
                                    ids: response.data.items.map(item => item.id.videoId)
                                }).then(resolve).catch(reject);
                            } else {
                                reject("Results not found");
                            }
                        }
                    });
                } else {
                    reject("No text to search by");
                }
            });
        },
        downloadVideo: (args) => {
            return new Promise((resolve, reject) => {
                const { videoUrl, videoTitle, savePath, downloadProgressCallback } = args;
                const vid = ytdl(videoUrl);
                vid.pipe(fs.createWriteStream(path.join(savePath, safeFilename(videoTitle) + ".mp4")));
                vid.on("response", response => {
                    if (downloadProgressCallback) {
                        let dataRead = 0;
                        const contentLength = response.headers["content-length"];
                        response.on("data", data => {
                            dataRead += data.length;
                            downloadProgressCallback({
                                progress: dataRead / contentLength * 100,
                                contentLength
                            });
                        });
                    }
                    response.on("end", resolve);
                }).on("error", reject);
            });
        },
        downloadMusic: (args) => {
            return new Promise((resolve, reject) => {
                const { savePath, videoTitle, videoUrl, downloadProgressCallback } = args;
                let dataRead = 0;
                downloadVideo({
                    savePath,
                    videoTitle,
                    videoUrl,
                    downloadProgressCallback: callbackArgs => {
                        dataRead = (callbackArgs.progress / 2);
                        downloadProgressCallback({
                            progress: dataRead,
                            videoProgress: callbackArgs.progress,
                            musicProgress: 0
                        });
                    }
                })
                    .then(response => {
                        const fileName = safeFilename(videoTitle);
                        const videoPath = path.join(savePath, `${fileName}.mp4`);
                        const mp3Path = path.join(savePath, `${fileName}.mp3`);
                        ffmpeg(videoPath)
                        .format("mp3")
                        .on("progress", progress => {
                            dataRead += (progress.percent / 2);
                            downloadProgressCallback({
                                progress: dataRead,
                                musicProgress: progress.percent,
                                videoProgress: 100
                            });
                        })
                        .save(mp3Path)
                        .on("end", resolve)
                        .on("error", reject);
                    }).catch(reject);
            });
        },
        getItemDiskInformation: async function getItemDiskInformation(args) {
            const { title, filePath, fileTypes } = args;
            const info = {};
            if (title && filePath && fileTypes) {
                const safeTitle = safeFilename(title);
                info.safeTitle = safeTitle;
                await Promise.all(fileTypes.map(async fileType => {
                    try {
                        await fs.promises.access(path.join(filePath, safeTitle + fileType));
                        info[fileType] = true;
                    } catch (error) {
                        info[fileType] = false;
                    }
                }));
            }
            return info;
        }
    }
};

exports.YOUTUBE = YOUTUBE;