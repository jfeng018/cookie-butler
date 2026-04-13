# 多阶段构建 - 构建阶段（指定 amd64 避免在 ARM 主机上 QEMU 模拟构建时 V8 JIT SIGILL）
FROM --platform=$BUILDPLATFORM node:22-alpine AS builder

# 设置工作目录
WORKDIR /app

# 复制package文件
COPY package*.json ./

# 安装依赖
RUN npm install --omit=dev && npm cache clean --force

# 多阶段构建 - 运行阶段
FROM node:22-alpine AS runner

# 安装dumb-init用于信号处理
RUN apk add --no-cache dumb-init

# 创建非root用户
RUN addgroup -g 1001 -S appgroup && \
    adduser -S appuser -u 1001

# 设置工作目录
WORKDIR /app

# 从构建阶段复制node_modules
COPY --from=builder --chown=appuser:appgroup /app/node_modules ./node_modules

# 复制应用代码
COPY --chown=appuser:appgroup . .

# 设置环境变量
ENV NODE_ENV=production
ENV PORT=3000

# 暴露端口
EXPOSE 3000

# 切换到非root用户
USER appuser

# 使用dumb-init启动应用
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dev-server.js"]
