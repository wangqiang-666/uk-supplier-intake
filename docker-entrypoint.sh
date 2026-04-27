#!/bin/sh
# 容器启动脚本：保持 Xvfb 存活 + 启动 PM2
# Law Society 爬虫需要 headful Chromium，依赖 Xvfb 虚拟显示
# 如果 Xvfb 崩溃，后台循环会自动重启，确保爬虫任何时候都能用

set -e

# 后台守护 Xvfb：死了就重启
(
  while true; do
    # 清理残留锁文件（上次崩溃可能留下）
    rm -f /tmp/.X99-lock /tmp/.X11-unix/X99 2>/dev/null || true
    echo "[entrypoint] 启动 Xvfb :99 @ $(date -u +%FT%TZ)"
    Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp >/dev/null 2>&1
    echo "[entrypoint] Xvfb 退出，2 秒后重启..."
    sleep 2
  done
) &

# 等待 Xvfb 就绪（最多 10 秒）
for i in $(seq 1 20); do
  if [ -e /tmp/.X11-unix/X99 ]; then
    echo "[entrypoint] Xvfb 就绪"
    break
  fi
  sleep 0.5
done

# 启动 PM2（前台运行，进程保持）
exec pm2-runtime start ecosystem.config.js
