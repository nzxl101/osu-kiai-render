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
const moment = require("moment");

const osu = "C:\\Users\\rzbwi\\AppData\\Local\\osu\!\\Songs";
const danser = path.join(__dirname, "danser", "danser-cli.exe");

const stream_copy = [
    "-c:v copy",
    "-c:a copy"
];

const filter_encode = [
    "-c:v h264_nvenc",
    "-c:a libopus",
    "-rc constqp",
    "-qp 30",
    "-profile main",
    "-preset p1",
    "-b:a 192k"
];

(async () => {
    console.time("Rendering")

    if(fs.readdirSync(path.join(danser, "..", "videos")).length >= 1) {
        await fsExtra.emptyDirSync(path.join(danser, "..", "videos"))
    }

    const replays = await getReplays(fs.readdirSync(path.join(__dirname, "replays")))
    console.log(`Found ${Object.entries(replays).length} replays ..`)

    await renderReplays(replays)

    console.log(`Crossfading all replays into one video ..`)
    await concatReplays(replays)

    console.log(`Adding a proper Fade In and Out ..`)
    await fadeInOutReplay(replays[Object.keys(replays)[Object.entries(replays).length - 1]].id)

    console.log(`Done!`)
    console.timeEnd("Rendering")

    if(fs.readdirSync(path.join(danser, "..", "videos")).length >= 1) {
        await fsExtra.emptyDirSync(path.join(danser, "..", "videos"))
    }

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
            let mods = parseMods(osr.readSync(path.join(__dirname, "replays", replayFiles[i])).mods)

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
            length = mods.match(/DT|HT|NC/) != null ? mods.match(/DT|NC/) != null ? Math.floor(beatmap.totalTime - (beatmap.totalTime / 100) * 33) : Math.floor(beatmap.totalTime + (beatmap.totalTime / 100) * 33) : beatmap.totalTime

            await new Promise((resolve) => {
                for (let i = 0; i < beatmap.timingPoints.length; i++) {
                    if(beatmap.timingPoints[i].offset >= Math.floor((length * 1000) / 2)) {
                        if(beatmap.timingPoints[i].kiaiTimeActive == true || beatmap.timingPoints[i].timingChange == true ||
                            beatmap.timingPoints[i].bpm != beatmap.bpmMin || beatmap.timingPoints[i].velocity != beatmap.timingPoints[0].velocity) {
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
                kiai: mods.match(/DT|HT|NC/) != null ? mods.match(/DT|NC/) != null ? Math.floor((kiai-start) - ((kiai-start) / 100) * 33) : Math.floor((kiai-start) + ((kiai-start) / 100) * 33) : (kiai-start),
                length: length,
                id: (Math.random() + 1).toString(36).substring(7),
                index: Object.entries(parsedFiles).length+1
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
                height: 400,
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
                .setStartTime(4)
                .setDuration(10)
                .outputOptions(stream_copy)
                .output(replay.saved.replace(".mp4", `_${replay.id}_intro.mp4`))

            let getKiai = ffmpeg(replay.saved)
                .setStartTime(replay.kiai)
                .setDuration(30)
                .outputOptions(stream_copy)
                .output(replay.saved.replace(".mp4", `_${replay.id}_kiai.mp4`))

            let concatKiaiIntro = ffmpeg(replay.saved.replace(".mp4", `_${replay.id}_intro.mp4`))
                .addInput(replay.saved.replace(".mp4", `_${replay.id}_kiai.mp4`))
                .complexFilter(`xfade=transition=fade:duration=1:offset=9;acrossfade=duration=1`)
                .outputOptions(filter_encode)
                .output(replay.saved.replace(".mp4", `_${replay.id}_concat.mp4`))

            if((duration-5)-replay.kiai >= 40) {
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

            if(fs.existsSync(replay.saved.replace(".mp4", `_${replay.id}_intro.mp4`))) {
                await new Promise((r) => {
                    concatKiaiIntro
                        .on("end", () => r())
                        .run()
                })
            }

            let page = await browser.newPage()
            await page.goto(path.join(__dirname, `text.html?title=${replay.title}&sub=${replay.sr}&index=${replay.index}`))
            await page.screenshot({
                omitBackground: true,
                path: `${replay.saved.replace(".mp4", `_${replay.id}.png`)}`
            })
            await page.close()

            await new Promise((p) => setTimeout(p, 500)) //sanity

            await new Promise((r) => {
                let addTextOverlay = ffmpeg(fs.existsSync(replay.saved.replace(".mp4", `_${replay.id}_concat.mp4`)) == true ? replay.saved.replace(".mp4", `_${replay.id}_concat.mp4`) : replay.saved.replace(".mp4", `_${replay.id}_kiai.mp4`))
                    .addInput(replay.saved.replace(".mp4", `_${replay.id}.png`))
                    .complexFilter(`[0:v][1:v]overlay=0:225:enable='gt(t,0)'`)
                    .outputOptions(filter_encode)
                    .output(replay.saved.replace(".mp4", `_${replay.id}_edited.mp4`))

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
        let previousTitle = []
        
        for (let x = 0; x < Object.entries(replays).length; x++) {
            let replay = replays[Object.keys(replays)[x]]

            let duration = null
            await new Promise((r) => {
                ffprobe(replay.saved.replace(".mp4", `_${replay.id}_edited.mp4`), (err, metadata) => {
                    duration = metadata.format.duration
                    r()
                })
            })

            toCrossfade.push(`${replay.saved.replace(".mp4", `_${replay.id}_edited.mp4`)}`)
            previousTitle.push(replay.title)
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
                        let timestamps = []
                        let sum = 0

                        previousOffset.forEach((value, i) => {
                            let cloned = previousOffset.slice()
                            sum += value
                            timestamps.push(`${moment(Math.floor(sum - cloned[i]) * 1000).format("mm:ss")} ${previousTitle[i]}`)
                        })
                        fs.writeFileSync(`${replay.id}.txt`, timestamps.join("\n"), "utf-8")

                        let concatCommand = ffmpeg()
                        toCrossfade.forEach(file => concatCommand.input(file))
                        concatCommand
                            .complexFilter(settb.concat(atrim, xFadeFilters, audioFilters).join(" ").replace(/\s/g, ""))
                            .outputOptions(filter_encode.concat(["-map [video]", "-map [audio]"]))
                            .output(`${replay.id}.mp4`)
                            .on('end', () => resolve())
                            .run()
                    }
                }
            }
        }
    })
}

function fadeInOutReplay(id) {
    return new Promise(async (resolve) => {
        let duration = null
        await new Promise((r) => {
            ffprobe(`${id}.mp4`, (err, metadata) => {
                duration = metadata.format.duration
                r()
            })
        })

        ffmpeg(`${id}.mp4`)
            .complexFilter(`[0:v]fade=type=in:duration=1,fade=type=out:duration=1:start_time=${duration-1}[video];[0:a]afade=type=in:duration=1,afade=type=out:duration=1:start_time=${duration-1}[audio]`)
            .outputOptions(filter_encode.concat(["-map [video]", "-map [audio]"]))
            .output(`${id}_output.mp4`)
            .on('end', () => {
                fs.unlinkSync(`${id}.mp4`)
                resolve()
            })
            .run()
    })
}

function parseMods(num) {
    let list = [];

    if(Number(num)) {
        if((num & 1<<0) != 0) list.push("NF");
        if((num & 1<<1) != 0) list.push("EZ");
        if((num & 1<<3) != 0) list.push("HD");
        if((num & 1<<4) != 0) list.push("HR");
        if((num & 1<<5) != 0) list.push("SD");
        else if((num & 1<<14) != 0) list.push("PF");
        if((num & 1<<9) != 0) list.push("NC");
        else if((num & 1<<6) != 0) list.push("DT");
        if((num & 1<<7) != 0) list.push("RX");
        if((num & 1<<8) != 0) list.push("HT");
        if((num & 1<<10) != 0) list.push("FL");
        if((num & 1<<12) != 0) list.push("SO");
    }

    return list.length >= 1 ? `${list.join("")}` : "NM";
}