FROM node:20-slim

# Install system dependencies (rsvg-convert, ffmpeg, yt-dlp, imagemagick)
RUN apt-get update && apt-get install -y \
    librsvg2-bin \
    ffmpeg \
    imagemagick \
    curl \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Install yt-dlp
RUN pip3 install --break-system-packages yt-dlp

# Set working directory
WORKDIR /app

# Copy package files
COPY package.json ./

# Install dependencies
RUN npm install --production

# Copy bot files
COPY alya36.js ./
COPY config.json* ./

# Create session directory
RUN mkdir -p /app/sesi

# Set timezone to WIB
ENV TZ=Asia/Jakarta

# Run bot
CMD ["node", "alya29.js"]
