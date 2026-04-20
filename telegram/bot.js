import axios from 'axios';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { platformFactory } from '../api/platforms/index.js';
import { STATUS } from '../api/utils/common.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const platformConfig = JSON.parse(
    readFileSync(path.resolve(projectRoot, 'api/config/platforms.json'), 'utf-8')
);

const TELEGRAM_API_ROOT = 'https://api.telegram.org';
const DEFAULT_UPDATE_TIMEOUT = 25;
const DEFAULT_STATUS_INTERVAL = 3000;
const DEFAULT_QR_TIMEOUT = platformConfig.common?.sessionTTL || 300000;
const PLATFORM_KEYS = [
    'quark',
    'uc',
    'uc_token',
    'baidu',
    'ali',
    'guangyapan',
    '115',
    'bilibili'
].filter((key) => platformFactory.isSupported(key));
const PLATFORM_LABELS = {
    quark: '夸克',
    uc: 'UC',
    uc_token: 'UT',
    guangyapan: '光鸭',
    baidu: '百度',
    ali: '阿里',
    '115': '115',
    bilibili: 'B站'
};

function buildSelectorCaption() {
    return '选择一个平台开始扫码，结果会直接回到当前私聊。';
}

function toInteger(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseAllowedChatIds(value) {
    if (!value) {
        return null;
    }

    const ids = value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);

    return ids.length > 0 ? new Set(ids) : null;
}

function escapeHtml(value = '') {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function buildMultipartBody(fields, files = []) {
    const boundary = `----CookieButlerTelegram${Date.now().toString(16)}`;
    const parts = [];

    for (const [name, rawValue] of Object.entries(fields)) {
        if (rawValue === undefined || rawValue === null) {
            continue;
        }

        const value =
            typeof rawValue === 'string'
                ? rawValue
                : typeof rawValue === 'number'
                  ? String(rawValue)
                  : JSON.stringify(rawValue);

        parts.push(
            Buffer.from(
                `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
            )
        );
    }

    for (const file of files) {
        parts.push(
            Buffer.from(
                `--${boundary}\r\nContent-Disposition: form-data; name="${file.fieldName}"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`
            )
        );
        parts.push(file.buffer);
        parts.push(Buffer.from('\r\n'));
    }

    parts.push(Buffer.from(`--${boundary}--\r\n`));
    return {
        body: Buffer.concat(parts),
        boundary
    };
}

function parseDataUrlToBuffer(dataUrl) {
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) {
        throw new Error('二维码数据格式无效');
    }

    const [, base64Data = ''] = dataUrl.split(',');
    if (!base64Data) {
        throw new Error('二维码数据为空');
    }

    return Buffer.from(base64Data, 'base64');
}

function isCommand(text, command) {
    if (typeof text !== 'string') {
        return false;
    }

    return new RegExp(`^/${command}(?:@\\w+)?(?:\\s|$)`, 'i').test(text.trim());
}

function buildStatusCaption(platform, status) {
    const platformName = PLATFORM_LABELS[platform] || platform;

    switch (status) {
        case STATUS.SCANNED:
            return `<b>${escapeHtml(platformName)}</b>\n已扫码，请在手机上确认登录。`;
        case STATUS.CONFIRMED:
            return `<b>${escapeHtml(platformName)}</b>\n登录成功，结果已经发到下方消息。`;
        case STATUS.EXPIRED:
            return `<b>${escapeHtml(platformName)}</b>\n二维码已过期，重新点按钮再来一轮。`;
        case STATUS.CANCELED:
            return `<b>${escapeHtml(platformName)}</b>\n登录已取消，可以重新选择平台。`;
        default:
            return `<b>${escapeHtml(platformName)}</b>\n请尽快使用对应 APP 扫码登录。`;
    }
}

function buildResultMessage(platform, payload) {
    const platformName = PLATFORM_LABELS[platform] || platform;

    if (payload.cookie) {
        return {
            text: `<b>${escapeHtml(platformName)}</b>\n<code>${escapeHtml(payload.cookie)}</code>`,
            filename: platform === 'guangyapan' ? `${platform}.token.txt` : `${platform}.cookie.txt`,
            plainText: payload.cookie
        };
    }

    if (payload.token || payload.refresh_token) {
        const lines = [];

        if (platform === 'ali' && payload.token) {
            lines.push(payload.token);
        } else if (platform === 'uc_token' && payload.token) {
            lines.push(payload.token);
        } else if (payload.token) {
            lines.push(`access_token=${payload.token}`);
        }

        if (payload.refresh_token) {
            lines.push(`refresh_token=${payload.refresh_token}`);
        }

        if (payload.expires_in) {
            lines.push(`expires_in=${payload.expires_in}`);
        }

        return {
            text: `<b>${escapeHtml(platformName)}</b>\n<code>${escapeHtml(
                lines.join('\n')
            )}</code>`,
            filename: `${platform}.token.txt`,
            plainText: lines.join('\n')
        };
    }

    return {
        text: `<b>${escapeHtml(platformName)}</b>\n登录成功，但没有拿到可发送的结果。`,
        filename: `${platform}.result.txt`,
        plainText: ''
    };
}

class TelegramBotService {
    constructor() {
        this.token = process.env.TELEGRAM_BOT_TOKEN?.trim() || '';
        this.baseUrl = `${TELEGRAM_API_ROOT}/bot${this.token}`;
        this.allowedChatIds = parseAllowedChatIds(
            process.env.TELEGRAM_BOT_ALLOWED_CHAT_IDS
        );
        this.updateTimeoutSeconds = toInteger(
            process.env.TELEGRAM_BOT_UPDATE_TIMEOUT,
            DEFAULT_UPDATE_TIMEOUT
        );
        this.statusIntervalMs = toInteger(
            process.env.TELEGRAM_BOT_STATUS_INTERVAL,
            DEFAULT_STATUS_INTERVAL
        );
        this.qrTimeoutMs = toInteger(
            process.env.TELEGRAM_BOT_QR_TIMEOUT,
            DEFAULT_QR_TIMEOUT
        );
        this.offset = 0;
        this.running = false;
        this.activeTasks = new Map();
        this.pollingPromise = null;
        this.currentPollAbortController = null;
        this.placeholderBuffer = null;
    }

    isEnabled() {
        return Boolean(this.token);
    }

    async start() {
        if (!this.isEnabled() || this.running) {
            return;
        }

        const me = await this.callTelegram('getMe', {});
        await this.callTelegram('setMyCommands', {
            commands: [
                { command: 'start', description: '打开平台选择菜单' },
                { command: 'ck', description: '获取网盘 Cookie 或 Token' }
            ]
        });

        this.running = true;
        this.pollingPromise = this.pollLoop();
        console.log(
            `[Telegram] 机器人已启动: @${me.username || me.first_name || 'unknown'}`
        );
    }

    async stop() {
        if (!this.running) {
            return;
        }

        this.running = false;
        this.currentPollAbortController?.abort();

        for (const chatId of Array.from(this.activeTasks.keys())) {
            this.cancelTask(chatId);
        }

        try {
            await this.pollingPromise;
        } catch (error) {
            if (error.name !== 'CanceledError' && error.code !== 'ERR_CANCELED') {
                console.error('[Telegram] 停止轮询时发生错误:', error.message);
            }
        } finally {
            this.pollingPromise = null;
        }

        console.log('[Telegram] 机器人已停止');
    }

    async pollLoop() {
        while (this.running) {
            this.currentPollAbortController = new AbortController();

            try {
                const updates = await this.callTelegram(
                    'getUpdates',
                    {
                        offset: this.offset,
                        timeout: this.updateTimeoutSeconds,
                        allowed_updates: ['message', 'callback_query']
                    },
                    {
                        signal: this.currentPollAbortController.signal,
                        timeout: (this.updateTimeoutSeconds + 5) * 1000
                    }
                );

                for (const update of updates) {
                    this.offset = update.update_id + 1;
                    await this.handleUpdate(update);
                }
            } catch (error) {
                if (!this.running) {
                    return;
                }

                if (error.name === 'CanceledError' || error.code === 'ERR_CANCELED') {
                    return;
                }

                console.error('[Telegram] 轮询失败:', error.message);
                await this.delay(3000);
            }
        }
    }

    async handleUpdate(update) {
        if (update.message) {
            await this.handleMessage(update.message);
        }

        if (update.callback_query) {
            await this.handleCallbackQuery(update.callback_query);
        }
    }

    async handleMessage(message) {
        const access = this.validateChat(message.chat);
        if (!access.allowed) {
            if (access.reply) {
                await this.sendTextMessage(message.chat.id, access.message);
            }
            return;
        }

        const text = message.text || '';
        if (isCommand(text, 'start') || isCommand(text, 'ck')) {
            this.cancelTask(message.chat.id);
            await this.sendPlatformSelector(message.chat.id);
        }
    }

    async handleCallbackQuery(query) {
        const message = query.message;
        const chat = message?.chat;
        const data = query.data || '';

        if (!chat || !data.startsWith('ck:')) {
            await this.answerCallbackQuery(query.id);
            return;
        }

        const access = this.validateChat(chat);
        if (!access.allowed) {
            await this.answerCallbackQuery(query.id, access.message, true);
            return;
        }

        if (data === 'ck:return') {
            this.cancelTask(chat.id);
            await this.answerCallbackQuery(query.id, '返回平台选择');
            await this.returnToSelector(message);
            return;
        }

        if (data === 'ck:close') {
            this.cancelTask(chat.id);
            await this.answerCallbackQuery(query.id, '已关闭');
            await this.deleteMessage(chat.id, message.message_id);
            return;
        }

        if (data.startsWith('ck:platform:')) {
            const platform = data.slice('ck:platform:'.length);
            if (!PLATFORM_KEYS.includes(platform)) {
                await this.answerCallbackQuery(query.id, '这个平台不支持', true);
                return;
            }

            await this.answerCallbackQuery(query.id, '正在生成二维码...');
            await this.openPlatform(chat.id, message, platform);
        }
    }

    validateChat(chat) {
        if (chat.type !== 'private') {
            return {
                allowed: false,
                reply: false,
                message: '只支持私聊使用，群里别乱扔 Cookie。'
            };
        }

        if (
            this.allowedChatIds &&
            !this.allowedChatIds.has(String(chat.id))
        ) {
            return {
                allowed: false,
                reply: true,
                message: '当前会话未被授权使用这个机器人。'
            };
        }

        return {
            allowed: true,
            reply: false,
            message: ''
        };
    }

    async sendPlatformSelector(chatId) {
        return this.sendPhotoMessage(
            chatId,
            this.getPlaceholderBuffer(),
            buildSelectorCaption(),
            this.createPlatformKeyboard()
        );
    }

    createPlatformKeyboard(currentPlatform = null) {
        const rows = [];

        for (let index = 0; index < PLATFORM_KEYS.length; index += 2) {
            const row = PLATFORM_KEYS.slice(index, index + 2).map((key) => ({
                text: PLATFORM_LABELS[key],
                callback_data: `ck:platform:${key}`
            }));
            rows.push(row);
        }

        rows.push([{ text: '返回选择', callback_data: 'ck:return' }]);
        rows.push([{ text: '关闭', callback_data: 'ck:close' }]);

        return {
            inline_keyboard: rows
        };
    }

    async openPlatform(chatId, sourceMessage, platform) {
        this.cancelTask(chatId);

        let result;
        try {
            const platformInstance = platformFactory.create(platform);
            result = await platformInstance.generateQRCode();
        } catch (error) {
            console.error(`[Telegram] ${platform} 生成二维码失败:`, error.message);
            result = {
                success: false,
                message: error.message
            };
        }

        if (!result?.success || !result.data?.qrcode || !result.data?.sessionKey) {
            await this.renderOpenPlatformError(sourceMessage, platform, result?.message);
            return;
        }

        const caption = buildStatusCaption(platform, STATUS.NEW);
        const keyboard = this.createPlatformKeyboard(platform);
        const photoBuffer = parseDataUrlToBuffer(result.data.qrcode);
        let messageId = sourceMessage.message_id;

        if (sourceMessage.photo?.length) {
            await this.editPhotoMessage(chatId, messageId, photoBuffer, caption, keyboard);
        } else {
            await this.deleteMessage(chatId, messageId);
            const sentMessage = await this.sendPhotoMessage(
                chatId,
                photoBuffer,
                caption,
                keyboard
            );
            messageId = sentMessage.message_id;
        }

        this.startStatusTask({
            chatId,
            messageId,
            platform,
            sessionKey: result.data.sessionKey
        });
    }

    async renderOpenPlatformError(sourceMessage, platform, message) {
        const platformName = PLATFORM_LABELS[platform] || platform;
        const text = `<b>${escapeHtml(platformName)}</b>\n生成二维码失败：${escapeHtml(
            message || '未知错误'
        )}`;

        if (sourceMessage.photo?.length) {
            await this.editPhotoCaption(
                sourceMessage.chat.id,
                sourceMessage.message_id,
                text,
                this.createPlatformKeyboard(platform)
            );
            return;
        }

        await this.editTextMessage(
            sourceMessage.chat.id,
            sourceMessage.message_id,
            text,
            this.createPlatformKeyboard()
        );
    }

    startStatusTask(taskInfo) {
        const state = {
            cancelled: false,
            ...taskInfo
        };

        state.promise = this.pollLoginStatus(state)
            .catch((error) => {
                if (!state.cancelled) {
                    console.error(
                        `[Telegram] ${state.platform} 状态轮询失败:`,
                        error.message
                    );
                }
            })
            .finally(() => {
                const current = this.activeTasks.get(state.chatId);
                if (current === state) {
                    this.activeTasks.delete(state.chatId);
                }
            });

        this.activeTasks.set(state.chatId, state);
    }

    cancelTask(chatId) {
        const task = this.activeTasks.get(chatId);
        if (!task) {
            return false;
        }

        task.cancelled = true;
        this.activeTasks.delete(chatId);
        return true;
    }

    async pollLoginStatus(task) {
        const startedAt = Date.now();
        let currentStatus = STATUS.NEW;

        while (this.running && !task.cancelled) {
            if (Date.now() - startedAt >= this.qrTimeoutMs) {
                await this.finishTaskWithStatus(task, STATUS.EXPIRED);
                return;
            }

            await this.delay(this.statusIntervalMs);
            if (!this.running || task.cancelled) {
                return;
            }

            let result;
            try {
                const platformInstance = platformFactory.create(task.platform);
                result = await platformInstance.checkStatus(task.sessionKey);
            } catch (error) {
                console.error(
                    `[Telegram] ${task.platform} 状态检查失败:`,
                    error.message
                );
                continue;
            }

            if (!result?.success || !result.data) {
                console.error(
                    `[Telegram] ${task.platform} 状态接口返回异常:`,
                    result?.message || 'unknown error'
                );
                continue;
            }

            const status = result.data.status || STATUS.NEW;
            if (status === currentStatus && status !== STATUS.CONFIRMED) {
                continue;
            }

            currentStatus = status;

            if (status === STATUS.SCANNED) {
                await this.editPhotoCaption(
                    task.chatId,
                    task.messageId,
                    buildStatusCaption(task.platform, status),
                    this.createPlatformKeyboard(task.platform)
                );
                continue;
            }

            if (status === STATUS.CONFIRMED) {
                await this.finishTaskWithStatus(task, status, result.data);
                return;
            }

            if (status === STATUS.EXPIRED || status === STATUS.CANCELED) {
                await this.finishTaskWithStatus(task, status);
                return;
            }
        }
    }

    async finishTaskWithStatus(task, status, payload = null) {
        await this.replaceWithPlaceholder(
            task.chatId,
            task.messageId,
            buildStatusCaption(task.platform, status),
            this.createPlatformKeyboard(task.platform)
        );

        if (status === STATUS.CONFIRMED && payload) {
            await this.sendResult(task.chatId, task.platform, payload);
        }
    }

    async sendResult(chatId, platform, payload) {
        const result = buildResultMessage(platform, payload);

        if (result.plainText.length > 3500) {
            await this.sendTextDocument(
                chatId,
                result.filename,
                result.plainText,
                `${PLATFORM_LABELS[platform] || platform} 登录结果`
            );
            return;
        }

        await this.sendTextMessage(chatId, result.text);
    }

    async returnToSelector(message) {
        const chatId = message.chat.id;
        const messageId = message.message_id;

        if (message.photo?.length) {
            await this.replaceWithPlaceholder(
                chatId,
                messageId,
                buildSelectorCaption(),
                this.createPlatformKeyboard()
            );
            return;
        }

        await this.deleteMessage(chatId, messageId);
        await this.sendPlatformSelector(chatId);
    }

    async callTelegram(method, payload, extraConfig = {}) {
        const response = await axios.post(`${this.baseUrl}/${method}`, payload, {
            headers: {
                'Content-Type': 'application/json'
            },
            timeout: 30000,
            ...extraConfig
        });

        if (!response.data?.ok) {
            throw new Error(response.data?.description || `${method} 调用失败`);
        }

        return response.data.result;
    }

    async callTelegramMultipart(method, fields, files) {
        const { body, boundary } = buildMultipartBody(fields, files);
        const response = await axios.post(`${this.baseUrl}/${method}`, body, {
            headers: {
                'Content-Type': `multipart/form-data; boundary=${boundary}`
            },
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
            timeout: 30000
        });

        if (!response.data?.ok) {
            throw new Error(response.data?.description || `${method} 调用失败`);
        }

        return response.data.result;
    }

    async sendTextMessage(chatId, text, replyMarkup = undefined) {
        return this.callTelegram('sendMessage', {
            chat_id: chatId,
            text,
            parse_mode: 'HTML',
            reply_markup: replyMarkup
        });
    }

    async editTextMessage(chatId, messageId, text, replyMarkup = undefined) {
        return this.callTelegram('editMessageText', {
            chat_id: chatId,
            message_id: messageId,
            text,
            parse_mode: 'HTML',
            reply_markup: replyMarkup
        });
    }

    async sendPhotoMessage(chatId, photoBuffer, caption, replyMarkup = undefined) {
        return this.callTelegramMultipart(
            'sendPhoto',
            {
                chat_id: chatId,
                caption,
                parse_mode: 'HTML',
                reply_markup: replyMarkup
            },
            [
                {
                    fieldName: 'photo',
                    filename: 'qrcode.png',
                    contentType: 'image/png',
                    buffer: photoBuffer
                }
            ]
        );
    }

    async editPhotoMessage(chatId, messageId, photoBuffer, caption, replyMarkup) {
        return this.callTelegramMultipart(
            'editMessageMedia',
            {
                chat_id: chatId,
                message_id: messageId,
                media: {
                    type: 'photo',
                    media: 'attach://photo',
                    caption,
                    parse_mode: 'HTML'
                },
                reply_markup: replyMarkup
            },
            [
                {
                    fieldName: 'photo',
                    filename: 'qrcode.png',
                    contentType: 'image/png',
                    buffer: photoBuffer
                }
            ]
        );
    }

    async editPhotoCaption(chatId, messageId, caption, replyMarkup = undefined) {
        return this.callTelegram('editMessageCaption', {
            chat_id: chatId,
            message_id: messageId,
            caption,
            parse_mode: 'HTML',
            reply_markup: replyMarkup
        });
    }

    async replaceWithPlaceholder(chatId, messageId, caption, replyMarkup) {
        return this.editPhotoMessage(
            chatId,
            messageId,
            this.getPlaceholderBuffer(),
            caption,
            replyMarkup
        );
    }

    async sendTextDocument(chatId, filename, content, caption) {
        return this.callTelegramMultipart(
            'sendDocument',
            {
                chat_id: chatId,
                caption
            },
            [
                {
                    fieldName: 'document',
                    filename,
                    contentType: 'text/plain; charset=utf-8',
                    buffer: Buffer.from(content, 'utf-8')
                }
            ]
        );
    }

    async deleteMessage(chatId, messageId) {
        try {
            await this.callTelegram('deleteMessage', {
                chat_id: chatId,
                message_id: messageId
            });
        } catch (error) {
            console.warn('[Telegram] 删除消息失败:', error.message);
        }
    }

    async answerCallbackQuery(callbackQueryId, text = undefined, showAlert = false) {
        try {
            await this.callTelegram('answerCallbackQuery', {
                callback_query_id: callbackQueryId,
                text,
                show_alert: showAlert
            });
        } catch (error) {
            console.warn('[Telegram] 响应回调失败:', error.message);
        }
    }

    getPlaceholderBuffer() {
        if (!this.placeholderBuffer) {
            this.placeholderBuffer = readFileSync(
                path.resolve(projectRoot, 'public/shixiao.jpg')
            );
        }

        return this.placeholderBuffer;
    }

    delay(ms) {
        return new Promise((resolve) => {
            setTimeout(resolve, ms);
        });
    }
}

export function createTelegramBotService() {
    return new TelegramBotService();
}
