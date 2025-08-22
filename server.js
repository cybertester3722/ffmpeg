import express from "express";
import { exec } from "child_process";
import fs from "fs";
import fsPromises from "fs/promises";
import path from "path";
import fetch from "node-fetch";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: "10mb" }));

// CORS (optional)
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Auth-Token");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Simple auth (optional but recommended)
const AUTH_TOKEN = process.env.AUTH_TOKEN || "";

function run(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: 1024 * 1024 * 20 }, (err, stdout, stderr) => {
      if (err) {
        err.details = stderr?.toString();
        return reject(err);
      }
      resolve(stdout?.toString());
    });
  });
}

async function downloadToFile(url, outPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${url} -> ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fsPromises.writeFile(outPath, buf);
  return outPath;
}

app.post("/create-video", async (req, res) => {
  try {
    if (AUTH_TOKEN) {
      const t = req.headers["x-auth-token"];
      if (t !== AUTH_TOKEN) return res.status(401).json({ error: "Unauthorized" });
    }

    const {
      images = [],                // [{ url, duration }]
      audio,                      // "https://.../audio.mp3"
      outputPath = "stories/output.mp4", // e.g. "stories/my_story.mp4"
      width = 1920,
      height = 1080,
      fps = 25
    } = req.body || {};

    if (!Array.isArray(images) || images.length === 0) {
      return res.status(400).json({ error: "images[] required" });
    }
    if (!audio) {
      return res.status(400).json({ error: "audio url required" });
    }

    // temp workspace
    const workDir = "/tmp/work-" + Date.now();
    await fsPromises.mkdir(workDir, { recursive: true });

    // 1) download images
    const localImgs = [];
    for (let i = 0; i < images.length; i++) {
      const imgUrl = images[i].url;
      const dur = Number(images[i].duration || 3);
      const out = path.join(workDir, `img_${String(i).padStart(3, "0")}.png`);
      await downloadToFile(imgUrl, out);
      localImgs.push({ file: out, duration: dur });
    }

    // 2) download audio
    const audioFile = path.join(workDir, "audio.mp3");
    await downloadToFile(audio, audioFile);

    // 3) build ffconcat list (works for stills + durations)
    // Important: repeat last image to make duration stick
    const concatTxt = path.join(workDir, "list.txt");
    let concatContent = "ffconcat version 1.0\n";
    for (const i of localImgs) {
      concatContent += `file ${i.file}\n`;
      concatContent += `duration ${i.duration}\n`;
    }
    // repeat last image once:
    concatContent += `file ${localImgs[localImgs.length - 1].file}\n`;
    await fsPromises.writeFile(concatTxt, concatContent, "utf8");

    // 4) build video from images
    const videoFile = path.join(workDir, "video.mp4");
    // scale to fit and pad to requested size
    const vf = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,format=yuv420p`;
    await run(`ffmpeg -y -f concat -safe 0 -i "${concatTxt}" -vf "${vf}" -pix_fmt yuv420p -c:v libx264 -vsync vfr "${videoFile}"`);

    // 5) mux audio; -shortest ensures sync to the shorter of (video, audio)
    const finalFile = path.join(workDir, "final.mp4");
    await run(`ffmpeg -y -i "${videoFile}" -i "${audioFile}" -c:v copy -c:a aac -shortest "${finalFile}"`);

    // 6) upload to Supabase Storage (direct API)
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET_VIDEOS || "videos";
    const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    }

    const fileBuffer = await fsPromises.readFile(finalFile);
    const uploadUrl = `${SUPABASE_URL}/storage/v1/object/${encodeURIComponent(SUPABASE_BUCKET)}/${encodeURIComponent(outputPath)}`;

    const upRes = await fetch(uploadUrl, {
      method: "POST", // or PUT; POST is fine for object
      headers: {
        "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "video/mp4",
        "x-upsert": "true"
      },
      body: fileBuffer
    });

    if (!upRes.ok) {
      const txt = await upRes.text();
      throw new Error(`Supabase upload failed: ${upRes.status} ${txt}`);
    }

    const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/${encodeURIComponent(SUPABASE_BUCKET)}/${encodeURIComponent(outputPath)}`;

    res.json({
      success: true,
      url: publicUrl,
      size: fileBuffer.length,
      frames: images.length,
      fps,
      width,
      height
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message, details: err.details || "" });
  }
});

app.get("/", (_, res) => res.send("OK"));
app.listen(8080, () => console.log("Video service on :8080"));

