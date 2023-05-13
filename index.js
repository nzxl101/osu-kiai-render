const fs = require("fs");
const fsExtra = require("fs-extra");
const path = require("path");
const { exec } = require('child_process');
const sqlite3 = require('sqlite3').verbose();
const puppeteer = require('puppeteer');
const parser = require('osu-parser');

const osu = "C:\\Users\\rzbwi\\AppData\\Local\\osu\!\\Songs";
const danser = path.join(__dirname, "danser", "danser-cli.exe");
const db = new sqlite3.Database(path.join(danser, "..", "danser.db"));

const ffmpegSettings = [
    "-y",
    "-c:v h264_nvenc",
    "-c:a aac",
    "-rc constqp",
    "-qp 26",
    "-profile high",
    "-preset p7",
    "-g 450",
    "-b:v 10M",
    "-b:a 192k"
];

(async () => {
    console.time("Rendering")

    const browser = await puppeteer.launch({
        headless: "new",
        defaultViewport: {
            height: 100,
            width: 1400
        }
    })
    const replays = {}

    await new Promise((resolve) => {
        let replayFiles = fs.readdirSync(path.join(__dirname, "replays"))
        replayFiles.forEach((v, i) => {
            let song = v.replace(/\w+\s-\s/, "")

            let artist = song.match(/^(.*?)\s-\s(.*?)$/)
            let title = song.match(/-\s(.*?)\[/)
            let diff = song.match(/.*\s(\[(.*)\])\s\(.*\)/)
            let kiai = 0
            let start = 0
    
            db.get(`SELECT dir, file, title, artist, version FROM beatmaps WHERE title = "${title[1].trim()}" AND artist = "${artist[1].trim()}" AND version = "${diff[2]}"`, (err, row) => {
                if(typeof row == "undefined") {
                    return console.log(`Map ${artist[1].trim()} - ${title[1].trim()} not found!`);
                }
    
                parser.parseFile(path.join(osu, row.dir, row.file), (err, beatmap) => {
                    start = Math.floor(beatmap.hitObjects[0].startTime / 1000)
                    for (let i = 0; i < beatmap.timingPoints.length; i++) {
                        if(beatmap.timingPoints[i].offset > Math.floor((beatmap.totalTime * 1000) / 3)) {
                            if(beatmap.timingPoints[i].timingChange == true) {
                                kiai = Math.floor(beatmap.timingPoints[i].offset / 1000)
                                break;
                            } else if(beatmap.timingPoints[i].kiaiTimeActive == true) {
                                kiai = Math.floor(beatmap.timingPoints[i].offset / 1000)
                                break;
                            } else if(beatmap.timingPoints[i].bpm != beatmap.bpmMin) {
                                kiai = Math.floor(beatmap.timingPoints[i].offset / 1000)
                                break;
                            } else if(beatmap.timingPoints[i].velocity != beatmap.timingPoints[0].velocity) {
                                kiai = Math.floor(beatmap.timingPoints[i].offset / 1000)
                                break;
                            }
                        }
                    }
    
                    replays[`${v.replace(/[\n\r\s\t]+/g, "")}`] = {
                        file: `${path.join(__dirname, ".", "replays", v)}`,
                        sr: `${diff[2]}`,
                        saved: null,
                        title: `${artist[1].trim()} - ${title[1].trim()}`,
                        kiai: kiai-start
                    }
    
                    if((i+1) >= replayFiles.length) {
                        resolve()
                    }
                })
            })
        })
    })

    return console.log(replays);

    for (let k in replays) {
        await new Promise((async (resolve) => {
            rendering = true
            let replay = replays[k]

            console.log(`Rendering ${replay.title} ..`)

            let initialRender = exec(`"${danser}" -record -skip -debug -replay "${replay.file}" -settings TopMapsOfTheWeek`)
            initialRender.stdout.on("data", (o) => {
                videoFile = o.match(/Video is available at:\s+(.*)/)
                if(videoFile && replay.saved == null) {
                    replay.saved = videoFile[1]
                }
            })
            initialRender.on("exit", () => rendering = false)

            while (rendering) {
                await new Promise(p => setTimeout(p, 50))
            }

            let getDuration = exec(`ffprobe -v error -select_streams v:0 -print_format compact=print_section=0:nokey=1:escape=csv -show_entries stream=duration "${replay.saved}"`)
            getDuration.stdout.on("data", async (o) => {
                duration = Number(o)

                let skipToKiai = [`-i "${replay.saved}"`, `-ss ${((Math.floor(replay.kiai) - 5)) < 0 ? 0 : (Math.floor(replay.kiai) - 5)}`, `-to ${Math.floor(replay.kiai) + 25}`].concat(ffmpegSettings)
                let overlayText = [`-i "${replay.saved.replace(".mp4", "_kiai.mp4")}" -i "${replay.saved.replace(".mp4", ".png")}"`, `-filter_complex "[0:v][1:v] overlay=0:850:enable='gt(t,0)'"`].concat(ffmpegSettings)

                rendering = true

                let renderKiai = exec(`ffmpeg ${skipToKiai.join(" ")} "${replay.saved.replace(".mp4", "_kiai.mp4")}"`)
                renderKiai.on("exit", () => rendering = false)

                while (rendering) {
                    await new Promise(p => setTimeout(p, 50))
                }

                rendering = true

                let page = await browser.newPage()
                await page.goto(path.join(__dirname, `text.html?title=${replay.title}&sub=${replay.sr}`))
                await page.screenshot({
                    omitBackground: true,
                    path: `${replay.saved.replace(".mp4", ".png")}`
                })
                await page.close()

                rendering = true

                let renderOverlay = exec(`ffmpeg ${overlayText.join(" ")} "${replay.saved.replace(".mp4", "_edited.mp4")}"`)
                renderOverlay.on("exit", () => rendering = false)

                while (rendering) {
                    await new Promise(p => setTimeout(p, 50))
                }

                resolve()
            })
        }))
    }

    let toCrossfade = []
    let xFadeFilters = []
    let audioFilters = []
    let atrim = []
    let settb = []
    let i = 0
    let previousOffset = []
    let replayLength = Object.entries(replays).length

    for(let x in replays) {
        await new Promise((resolve) => {
            toCrossfade.push(`-i "${replays[x].saved.replace(".mp4", "_edited.mp4")}"`)

            let getOffset = exec(`ffprobe -v error -select_streams v:0 -print_format compact=print_section=0:nokey=1:escape=csv -show_entries stream=duration "${replays[x].saved.replace(".mp4", "_edited.mp4")}"`)
            getOffset.stdout.on("data", async (o) => {
                offset = Number(o)
                previousOffset.push(Number(offset).toFixed(3))

                if((i+1) >= replayLength) {
                    for (let y = 0; y < replayLength; y++) {
                        if(y == 0) {
                            xFadeFilters.push(`[0:v][1:v]xfade=transition=fade:duration=1:offset=${(previousOffset[0]-1)}${replayLength > 1 ? `[V${y+1}]` : ""};`)
                            audioFilters.push(`[0:a][1:a]acrossfade=duration=1:c1=tri:c2=tri${replayLength > 1 ? `[A${y+1}]` : "[audio]"};`)
                        } else {
                            if(y < replayLength-1) {
                                let clonedArray = previousOffset.slice()
                                xFadeFilters.push(`[V${y}][${y+1}:v]xfade=transition=fade:duration=1:offset=${Number(clonedArray.splice(0, (y+1)).reduce((partialSum, a) => partialSum + (a - 1), 0))}${y < replayLength-2 ? `[V${y+1}]` : ",format=yuv420p[video]"};`)
                                audioFilters.push(`[A${y}][${y+1}:a]acrossfade=duration=1:c1=tri:c2=tri${y < replayLength-2 ? `[A${y+1}]` : "[audio]"};`)
                            }
                        }

                        settb.push(`[${y}]settb=AVTB[${y}:v];`)
                        atrim.push(`[${y}]atrim=0:${previousOffset[y]}[${y}:a];`)
                    }
                }

                i++
                resolve()
            })
        })
    }

    let filterComplex = `-filter_complex "${settb.concat(atrim, xFadeFilters, audioFilters).join(" ").replace(/\s/g, "")}"`

    let ffmpegConcat = toCrossfade.concat(ffmpegSettings, [filterComplex], ["-map \"[video]\"", "-map \"[audio]\""])

    let finalRender = exec(`ffmpeg ${ffmpegConcat.join(" ")} output.mp4`)
    finalRender.on("exit", () => {
        let getOffset = exec(`ffprobe -v error -select_streams v:0 -print_format compact=print_section=0:nokey=1:escape=csv -show_entries stream=duration output.mp4`)
        getOffset.stdout.on("data", async (o) => {
            offset = Number(o).toFixed(3)

            let fadeInOut = exec(`ffmpeg -i output.mp4 ${ffmpegSettings.join(" ")} -filter_complex "[0:v]fade=type=in:duration=1,fade=type=out:duration=1:start_time=${offset-1}[video];[0:a]afade=type=in:duration=1,afade=type=out:duration=1:start_time=${offset-1}[audio]" -map "[video]" -map "[audio]" output_done.mp4`)
            fadeInOut.on("exit", async () => {
                await fsExtra.emptyDirSync(path.join(danser, "..", "videos"))
                await fs.unlinkSync("output.mp4")

                console.timeEnd("Rendering")
                process.exit()
            })
        })
    })

    console.log(`Putting all the videos together in a final cut..`)
})()