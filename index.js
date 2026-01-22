import express from "express";
import cors from "cors";
import youtubedl from "yt-dlp-exec";
// import { rssToJson } from "rss-to-json";
import rssParser from "rss-to-json";

const app = express();
app.use(cors());
app.use(express.json());


app.get("/", (req, res) => {
  res.send("API is running");
});

app.get("/channel/:id/videos", async (req, res) => {
  try {
    const channelId = req.params.id;
    const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;

    const rss = await rssParser.parse(feedUrl);

    const videos = rss.items.map((item) => {
      const videoId = item.id.replace("yt:video:", "");

      // SAFE thumbnail extraction
      let thumbnail = null;

      if (item.media?.thumbnail?.url) {
        thumbnail = item.media.thumbnail.url;
      } else if (item.media?.group?.thumbnail?.[0]?.url) {
        thumbnail = item.media.group.thumbnail[0].url;
      } else {
        thumbnail = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
      }

      return {
        title: item.title,
        videoId,
        link: item.link,
        thumbnail,
        description: item.description || "",
        published: item.published,
      };
    });

    res.json(videos);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Unable to fetch channel videos" });
  }
});

app.get("/video/:id/details", async (req, res) => {
  try {
    const videoId = req.params.id;
    const url = `https://www.youtube.com/watch?v=${videoId}`;

    const data = await youtubedl(url, {
      dumpSingleJson: true,
      ytDlpPath: "/usr/local/bin/yt-dlp",
      noWarnings: true,
      noCheckCertificates: true,
      preferFreeFormats: false,
    });

    // Filter formats
    const videoFormats = data.formats
      .filter((f) => f.vcodec !== "none") // has video
      .map((f) => ({
        quality: f.format_note || f.resolution,
        resolution: f.resolution,
        fps: f.fps,
        url: f.url,
        ext: f.ext,
      }));

    const audioFormats = data.formats
      .filter((f) => f.acodec !== "none" && f.vcodec === "none") // audio-only
      .map((f) => ({
        bitrate: f.abr,
        url: f.url,
        ext: f.ext,
      }));

    const response = {
      title: data.title,
      upload_date: data.upload_date,
      thumbnail: data.thumbnail,
      videoQualities: videoFormats,
      audioQualities: audioFormats,
    };

    res.json(response);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Unable to extract video details" });
  }
});

// 3. Fetch Live video qualities using yt-dlp
app.get("/channel/:id/live", async (req, res) => {
  try {
    const channelId = req.params.id;

    // First: Get channel RSS feed
    const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
    const rss = await rssParser.parse(feedUrl);

    // Find the latest video entry
    const item = rss.items[0];
    const videoId = item.id.replace("yt:video:", "");

    // Use yt-dlp to check if this is live and get formats
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const data = await youtubedl(url, {
      dumpSingleJson: true,
      ytDlpPath: "/usr/local/bin/yt-dlp",
      noWarnings: true,
      noCheckCertificates: true,
      preferFreeFormats: false
    });

    // Not live → return message
    if (!data.is_live) {
      return res.json({ live: false, message: "Channel is not live right now." });
    }

    // Extract only live formats (HLS)
    const videoQualities = data.formats
      .filter(f => f.vcodec !== "none")
      .map(f => ({
        quality: f.format_note,
        resolution: f.resolution,
        fps: f.fps,
        url: f.url
      }));

    const audioQualities = data.formats
      .filter(f => f.acodec !== "none" && f.vcodec === "none")
      .map(f => ({
        bitrate: f.abr,
        url: f.url
      }));

    return res.json({
      live: true,
      title: data.title,
      videoId,
      thumbnail: data.thumbnail,
      videoQualities,
      audioQualities
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Unable to fetch live stream" });
  }
});


/* ============================
   HLS PROXY
============================ */

app.get("/proxy", async (req, res) => {
  const targetUrl = req.query.url;

  if (!targetUrl) {
    return res.status(400).send("Missing url query param");
  }

  try {
    const headers = {};

    // Forward range header (MANDATORY for video)
    if (req.headers.range) {
      headers.range = req.headers.range;
    }

    const upstream = await fetch(targetUrl, { headers });

    const contentType = upstream.headers.get("content-type") || "";

    /* ============================
       CORS HEADERS
    ============================ */
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "*");

    /* ============================
       CACHE HEADERS
       (Segments cache well, playlists don't)
    ============================ */
    if (contentType.includes("video") || targetUrl.endsWith(".ts")) {
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    } else {
      res.setHeader("Cache-Control", "no-cache");
    }

    /* ============================
       HLS PLAYLIST REWRITE
    ============================ */
    if (
      contentType.includes("application/vnd.apple.mpegurl") ||
      contentType.includes("application/x-mpegURL") ||
      targetUrl.endsWith(".m3u8")
    ) {
      let playlist = await upstream.text();

      /**
       * Rewrite all URLs inside playlist
       * This handles:
       * - absolute URLs
       * - relative URLs
       */
      playlist = playlist.replace(
        /(https?:\/\/[^\s]+)/g,
        (url) => `/proxy?url=${encodeURIComponent(url)}`
      );

      playlist = playlist.replace(
        /^([^#\n][^\n]*)$/gm,
        (line) => {
          if (line.startsWith("/proxy")) return line;
          if (line.startsWith("#")) return line;
          if (line.startsWith("http")) {
            return `/proxy?url=${encodeURIComponent(line)}`;
          }

          const resolved = new URL(line, targetUrl).toString();
          return `/proxy?url=${encodeURIComponent(resolved)}`;
        }
      );

      res.setHeader(
        "Content-Type",
        "application/vnd.apple.mpegurl"
      );

      return res.send(playlist);
    }

    /* ============================
       SEGMENTS / MEDIA STREAM
    ============================ */
    res.status(upstream.status);

    upstream.headers.forEach((value, key) => {
      if (
        key === "content-type" ||
        key === "content-length" ||
        key === "content-range" ||
        key === "accept-ranges"
      ) {
        res.setHeader(key, value);
      }
    });

    upstream.body.pipe(res);
  } catch (err) {
    console.error("Proxy error:", err);
    res.status(500).send("Proxy failed");
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});