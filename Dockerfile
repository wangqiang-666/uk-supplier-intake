# 使用 Node.js 20 基础镜像
FROM node:20-slim

# 安装 Chromium 依赖（Puppeteer 需要）+ 编译工具（better-sqlite3 需要）+ xvfb（虚拟显示）+ curl（下载 docker CLI）
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf \
    ca-certificates \
    python3 make g++ \
    xvfb \
    curl \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# 安装 Docker CLI（仅 CLI，用于 docker exec 调用 openclaw-gateway 发送企微通知）
RUN curl -fsSL https://download.docker.com/linux/static/stable/$(uname -m)/docker-27.5.1.tgz \
    | tar xz --strip-components=1 -C /usr/local/bin docker/docker

# 设置 Puppeteer 使用系统 Chromium + 虚拟显示
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    DISPLAY=:99

# 设置工作目录
WORKDIR /app

# 复制 package.json 和 package-lock.json
COPY package*.json ./

# 安装依赖
RUN npm ci --only=production && npm install -g pm2

# 复制项目文件
COPY . .

# 创建数据目录
RUN mkdir -p /app/data /app/logs /app/output

# 确保启动脚本可执行
RUN chmod +x /app/docker-entrypoint.sh

# 暴露端口
EXPOSE 3000

# 启动命令：通过 entrypoint 脚本守护 Xvfb + 启动 PM2
CMD ["/app/docker-entrypoint.sh"]
