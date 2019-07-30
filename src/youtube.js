const fs = require("fs");
const path = require("path");

const moment = require("moment");
var momentDurationFormatSetup = require("moment-duration-format");
momentDurationFormatSetup(moment);

const ytdl = require("ytdl-core");
const ffmpeg = require("fluent-ffmpeg");

const { google } = require("googleapis");
const youtube = google.youtube("v3");

const uuid = require("uuid/v1");

function youtubeDurationToFf(duration) {
    if (duration) {
        return moment.duration(duration).format("hh:mm:ss");
    }
    return "";
}

function safeFilename(oFilaname) {
    return oFilaname.replace(/[^a-z0-9]/gi, '_').toLowerCase();
}

function idToURL(args) {
    const { id } = args;
    let url = new URL("https://www.youtube.com/watch");
    if (id) {
        url.searchParams.append("v", id);
    }
    return url;
}

let LOCAL_CREDENTIALS;

const YOUTUBE = (args) => {
    const { CREDENTIALS, ffmpegPaths, tmpDir } = args;
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
    const aux = {
        idToURL,
        safeFilename,
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
                                    let url = idToURL({id: item.id});
                                    return {
                                        id: item.id,
                                        title: item.snippet.title,
                                        video_url: url.href,
                                        thumbnail_url: thumbnails ? thumbnails.high.url : "",
                                        duration: youtubeDurationToFf(item.contentDetails.duration),
                                        disabled: false
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
                                aux.getVideosInfo({
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
                               aux.getVideosInfo({
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
                let { videoTitle, savePath, downloadProgressCallback, pipe, id } = args;
                if (!id) {
                    reject("No ID defined");
                    return;
                }
                let videoUrl = idToURL({id}).href;
                const vid = ytdl(videoUrl);
                if (!pipe) {
                    pipe = fs.createWriteStream(path.join(savePath, safeFilename(videoTitle) + ".mp4"));
                }
                vid.pipe(pipe);
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
                let { savePath, videoTitle, downloadProgressCallback, pipe, id } = args;

                if (!id) {
                    reject("No ID defined");
                    return;
                }

                let dataRead = 0;
                let auxPath = savePath;
                let auxTitle = videoTitle;
                if (pipe && tmpDir) {
                    auxPath = tmpDir;
                    auxTitle = uuid();
                }

                const videoDwnProgress = (callbackArgs) => {
                    dataRead = (callbackArgs.progress / 2);
                    downloadProgressCallback({
                        progress: dataRead,
                        videoProgress: callbackArgs.progress,
                        musicProgress: 0
                    });
                };

                aux.downloadVideo({
                    savePath: auxPath,
                    videoTitle: auxTitle,
                    id: id,
                    downloadProgressCallback: downloadProgressCallback ? videoDwnProgress : null
                })
                .then(response => {
                    const fileName = safeFilename(auxTitle);
                    const videoPath = path.join(auxPath, `${fileName}.mp4`);
                    const ff = ffmpeg(videoPath)
                    .format("mp3")
                    .on("progress", progress => {
                        if (downloadProgressCallback) {
                            dataRead += (progress.percent / 2);
                            downloadProgressCallback({
                                progress: dataRead,
                                musicProgress: progress.percent,
                                videoProgress: 100
                            });
                        }
                    });
                    if (pipe) {
                        ff.pipe(pipe);
                    } else {
                        ff.save(path.join(savePath, `${fileName}.mp3`));
                    }
                    ff.on("end", () => {
                        if (pipe) {
                            fs.unlink(videoPath, () => console.log(`tmp delete success ${auxPath}/${fileName}.mp4`));
                        }
                        resolve();
                    })
                    .on("error", error => {
                        if (pipe) {
                            fs.unlink(videoPath, () => console.log(`tmp delete success ${auxPath}/${fileName}.mp4`));
                        }
                        reject(error);
                    });
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
        },
        getDefVideoItem: function () {
            return {
                title: "",
                video_url: "",
                thumbnail_url: "",
                duration: "",
                diskInfo: {
                    mp3: false,
                    mp4: false
                },
                disabled: false,
                dwnProgress: {
                    progress: 0,
                    downloading: false,
                    video: {
                        progress: 0,
                        loading: false,
                        indeterminate: false
                    },
                    music: {
                        progress: 0,
                        loading: false,
                        indeterminate: false
                    }
                }
            };
        }
    };
    return aux;
};

exports.YOUTUBE = YOUTUBE;