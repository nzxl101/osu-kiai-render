const fs = require("fs");
const fsExtra = require("fs-extra");
const path = require("path");
const child_process = require('child_process');
const SQLite = require('@surfy/sqlite');
const puppeteer = require('puppeteer');
const parser = require('osu-parser');
const ffmpeg = require("fluent-ffmpeg");
const ffprobe = require("fluent-ffmpeg").ffprobe;
const osr = require('node-osr');

const osu = "C:\\Users\\rzbwi\\AppData\\Local\\osu\!\\Songs";
const danser = path.join(__dirname, "danser", "danser-cli.exe");

const ffmpegSettings = [
    "-c:v h264_nvenc",
    "-c:a aac",
    "-rc cbr",
    "-qp 26",
    "-profile high",
    "-preset p7",
    "-g 450",
    "-b:v 10M",
    "-b:a 192k"
];

(async () => {
    console.time("Rendering")

    const replays = await getReplays(fs.readdirSync(path.join(__dirname, "replays")))
    console.log(`Found ${Object.entries(replays).length} replays ..`)

    await renderReplays(replays)

    console.log(`Crossfading all replays into one video ..`)
    await concatReplays(replays)

    console.log(`Adding a proper Fade In and Out ..`)
    await fadeInOutReplay()

    console.log(`Done!`)
    console.timeEnd("Rendering")

    await fsExtra.emptyDirSync(path.join(danser, "..", "videos"))
    await fs.unlinkSync("output.mp4")

    process.exit()
})()

function getReplays(replayFiles = []) {
    return new Promise(async (resolve) => {
        let parsedFiles = {}
        let db = await SQLite(path.join(danser, "..", "danser.db"))

        for (let i = 0; i < replayFiles.length; i++) {
            let songTitle = replayFiles[i].replace(/\w+\s-\s/, "")
            let songName = songTitle.match(/-\s(.*?)\[/)
            let songArtist = songTitle.match(/^(.*?)\s-\s(.*?)$/)
            let songVersion = songTitle.match(/.*\s(\[(.*)\])\s\(.*\)/)

            let MD5 = osr.readSync(path.join(__dirname, "replays", replayFiles[i])).beatmapMD5

            let song = await db.get(`SELECT dir, file, title, artist, version FROM beatmaps WHERE title = "${songName[1].trim()}" AND artist = "${songArtist[1].trim()}" AND version = "${songVersion[2].trim()}" OR md5 = "${MD5}" LIMIT 1;`)
            if(typeof song == "undefined") {
                console.log(`${songTitle} not found!`)
                continue
            }

            let beatmap = null, kiai, start, length
            await new Promise((resolve) => {
                parser.parseFile(path.join(osu, song.dir, song.file), (err, map) => {
                    beatmap = map
                    resolve()
                })
            })

            start = Math.floor(beatmap.hitObjects[0].startTime / 1000)
            length = beatmap.totalTime

            await new Promise((resolve) => {
                for (let i = 0; i < beatmap.timingPoints.length; i++) {
                    if(beatmap.timingPoints[i].offset > Math.floor((beatmap.totalTime * 1000) / 3)) {
                        if(beatmap.timingPoints[i].timingChange == true) {
                            kiai = Math.floor(beatmap.timingPoints[i].offset / 1000)
                            resolve()
                            break;
                        } else if(beatmap.timingPoints[i].kiaiTimeActive == true) {
                            kiai = Math.floor(beatmap.timingPoints[i].offset / 1000)
                            resolve()
                            break;
                        } else if(beatmap.timingPoints[i].bpm != beatmap.bpmMin) {
                            kiai = Math.floor(beatmap.timingPoints[i].offset / 1000)
                            resolve()
                            break;
                        } else if(beatmap.timingPoints[i].velocity != beatmap.timingPoints[0].velocity) {
                            kiai = Math.floor(beatmap.timingPoints[i].offset / 1000)
                            resolve()
                            break;
                        }
                    }
                }
            })

            parsedFiles[`${replayFiles[i].replace(/[\n\r\s\t]+/g, "")}`] = {
                file: `${path.join(__dirname, ".", "replays", replayFiles[i])}`,
                sr: `${song.version}`,
                saved: null,
                title: `${song.artist} - ${song.title}`,
                kiai: kiai-start,
                length: length
            }

            if((i+1) >= replayFiles.length) {
                return resolve(parsedFiles)
            }
        }
    })
}

function renderReplays(replays = {}) {
    return new Promise(async (resolve) => {
        let browser = await puppeteer.launch({
            headless: "new",
            defaultViewport: {
                height: 100,
                width: 1400
            }
        })

        for (let k = 0; k < Object.entries(replays).length; k++) {
            let replay = replays[Object.keys(replays)[k]]
            console.log(`Rendering ${replay.title} ..`)

            let render = await child_process.execSync(`"${danser}" -record -skip -debug -replay "${replay.file}" -settings TopMapsOfTheWeek`, { stdio: [] }).toString()
            replay.saved = render.match(/Video is available at:\s+(.*)/)[1]

            let duration = null
            await new Promise((r) => {
                ffprobe(replay.saved, (err, metadata) => {
                    duration = metadata.format.duration
                    r()
                })
            })

            let getIntro = ffmpeg(replay.saved)
                .setStartTime(1)
                .setDuration(6)
                .outputOptions(ffmpegSettings)
                .output(replay.saved.replace(".mp4", "_intro.mp4"))

            let getKiai = ffmpeg(replay.saved)
                .setStartTime(replay.kiai)
                .setDuration(25)
                .outputOptions(ffmpegSettings)
                .output(replay.saved.replace(".mp4", "_kiai.mp4"))

            let concatKiaiIntro = ffmpeg(replay.saved.replace(".mp4", "_intro.mp4"))
                .addInput(replay.saved.replace(".mp4", "_kiai.mp4"))
                .complexFilter(`xfade=transition=fade:duration=1:offset=5;acrossfade=duration=1`)
                .outputOptions(ffmpegSettings)
                .output(replay.saved.replace(".mp4", "_concat.mp4"))

            if((duration-5)-replay.kiai >= 20) {
                await new Promise((r) => {
                    getIntro
                        .on("end", () => r())
                        .run()
                })
            }

            await new Promise((r) => {
                getKiai
                    .on("end", () => r())
                    .run()
            })

            if(fs.existsSync(replay.saved.replace(".mp4", "_intro.mp4"))) {
                await new Promise((r) => {
                    concatKiaiIntro
                        .on("end", () => r())
                        .run()
                })
            }

            let page = await browser.newPage()
            await page.goto(path.join(__dirname, `text.html?title=${replay.title}&sub=${replay.sr}`))
            await page.screenshot({
                omitBackground: true,
                path: `${replay.saved.replace(".mp4", ".png")}`
            })
            await page.close()

            await new Promise((r) => {
                let addTextOverlay = ffmpeg(fs.existsSync(replay.saved.replace(".mp4", "_concat.mp4")) == true ? replay.saved.replace(".mp4", "_concat.mp4") : replay.saved.replace(".mp4", "_kiai.mp4"))
                    .addInput(replay.saved.replace(".mp4", ".png"))
                    .complexFilter(`[0:v][1:v]overlay=0:850:enable='gt(t,0)'`)
                    .outputOptions(ffmpegSettings)
                    .output(replay.saved.replace(".mp4", "_edited.mp4"))

                addTextOverlay
                    .on("end", () => r())
                    .run()
            })

            if((k+1) >= Object.entries(replays).length) {
                resolve()
            }
        }
    })
}

function concatReplays(replays = {}) {
    return new Promise(async (resolve) => {
        let toCrossfade = []
        let xFadeFilters = [] 
        let audioFilters = [] 
        let atrim = []
        let settb = []
        let previousOffset = []
        
        for (let x = 0; x < Object.entries(replays).length; x++) {
            let replay = replays[Object.keys(replays)[x]]

            let duration = null
            await new Promise((r) => {
                ffprobe(replay.saved.replace(".mp4", "_edited.mp4"), (err, metadata) => {
                    duration = metadata.format.duration
                    r()
                })
            })

            toCrossfade.push(`${replay.saved.replace(".mp4", "_edited.mp4")}`)
            previousOffset.push(duration)

            if((x+1) >= Object.entries(replays).length) {
                for (let y = 0; y < toCrossfade.length; y++) {
                    if(y == 0) {
                        xFadeFilters.push(`[0:v][1:v]xfade=transition=fade:duration=1:offset=${(previousOffset[0]-1)}${toCrossfade.length > 2 ? `[V${y+1}]` : ",format=yuv420p[video]"};`)
                        audioFilters.push(`[0:a][1:a]acrossfade=duration=1:c1=tri:c2=tri${toCrossfade.length > 2 ? `[A${y+1}]` : "[audio]"};`)
                    } else {
                        if(y < toCrossfade.length - 1) {
                            let clonedArray = previousOffset.slice()
                            xFadeFilters.push(`[V${y}][${y+1}:v]xfade=transition=fade:duration=1:offset=${Number(clonedArray.splice(0, (y+1)).reduce((partialSum, a) => partialSum + (a - 1), 0))}${y < toCrossfade.length-2 ? `[V${y+1}]` : ",format=yuv420p[video]"};`)
                            audioFilters.push(`[A${y}][${y+1}:a]acrossfade=duration=1:c1=tri:c2=tri${y < toCrossfade.length-2 ? `[A${y+1}]` : "[audio]"};`)
                        }
                    }

                    settb.push(`[${y}]settb=AVTB[${y}:v];`)
                    atrim.push(`[${y}]atrim=0:${previousOffset[y]}[${y}:a];`)

                    if((y+1) >= toCrossfade.length) {
                        let concatCommand = ffmpeg()
                        toCrossfade.forEach(file => concatCommand.input(file))
                        concatCommand
                            .complexFilter(settb.concat(atrim, xFadeFilters, audioFilters).join(" ").replace(/\s/g, ""))
                            .outputOptions(ffmpegSettings.concat(["-map [video]", "-map [audio]"]))
                            .output("output.mp4")
                            .on('end', () => resolve())
                            .run()
                    }
                }
            }
        }
    })
}

function fadeInOutReplay() {
    return new Promise(async (resolve) => {
        let duration = null
        await new Promise((r) => {
            ffprobe("output.mp4", (err, metadata) => {
                duration = metadata.format.duration
                r()
            })
        })

        ffmpeg("output.mp4")
            .complexFilter(`[0:v]fade=type=in:duration=1,fade=type=out:duration=1:start_time=${duration-1}[video];[0:a]afade=type=in:duration=1,afade=type=out:duration=1:start_time=${duration-1}[audio]`)
            .outputOptions(ffmpegSettings.concat(["-map [video]", "-map [audio]"]))
            .output("output_done.mp4")
            .on('end', () => resolve())
            .run()
    })
}