# 1️⃣ Base computer (Linux + Node.js)
FROM node:20-slim

# 2️⃣ Install system tools needed by yt-dlp
RUN apt-get update && apt-get install -y \
  ffmpeg \
  curl \
  python3 \
  && ln -s /usr/bin/python3 /usr/bin/python \
  && rm -rf /var/lib/apt/lists/*

# 3️⃣ Install yt-dlp itself
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
  -o /usr/local/bin/yt-dlp \
  && chmod a+rx /usr/local/bin/yt-dlp

# 4️⃣ Create app folder inside the container
WORKDIR /app

# 5️⃣ Copy package files first (for faster builds)
COPY package*.json ./

# 6️⃣ Install Node.js dependencies
RUN npm install

# 7️⃣ Copy your actual app code
COPY . .

# 8️⃣ Tell Node this is production
ENV NODE_ENV=production

# 9️⃣ Start your server
CMD ["npm", "start"]
