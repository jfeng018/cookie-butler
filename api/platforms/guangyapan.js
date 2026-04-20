import { randomBytes } from 'crypto';
import { BasePlatform } from './base.js';
import { STATUS } from '../utils/common.js';

function normalizeResponseData(value) {
    if (!value) {
        return {};
    }

    if (typeof value === 'string') {
        try {
            return JSON.parse(value);
        } catch {
            return { message: value };
        }
    }

    return value;
}

function normalizeToken(value) {
    return String(value || '').trim();
}

function normalizeDeviceId(value) {
    let normalized = String(value || '').trim().toLowerCase();
    normalized = normalized.replace(/^wdi10\./, '');
    normalized = normalized.replace(/x+$/g, '');
    normalized = normalized.replace(/[^0-9a-f]/g, '');
    return normalized.length === 32 ? normalized : '';
}

function extractTokenPayload(payload) {
    const accessToken = normalizeToken(payload?.access_token || payload?.accessToken);
    const refreshToken = normalizeToken(payload?.refresh_token || payload?.refreshToken);
    return {
        accessToken,
        refreshToken
    };
}

/**
 * 光鸭云盘平台实现
 */
export class GuangYaPanPlatform extends BasePlatform {
    constructor() {
        super('guangyapan');
    }

    getClientId() {
        return normalizeToken(this.config.clientId);
    }

    createDeviceId() {
        try {
            return randomBytes(16).toString('hex');
        } catch {
            return (
                normalizeDeviceId(this.config.defaultDeviceId) ||
                '0123456789abcdef0123456789abcdef'
            );
        }
    }

    buildAccountHeaders(deviceId) {
        return {
            'User-Agent': this.getUserAgent(),
            'Accept': 'application/json, text/plain, */*',
            'Content-Type': 'application/json',
            'X-Client-Id': this.getClientId(),
            'X-Client-Version': this.getParam('clientVersion'),
            'X-Device-Id': deviceId,
            'X-Device-Model': this.getParam('deviceModel'),
            'X-Device-Name': this.getParam('deviceName'),
            'X-Device-Sign': `wdi10.${deviceId}xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`,
            'X-Net-Work-Type': this.getParam('networkType'),
            'X-OS-Version': this.getParam('osVersion'),
            'X-Platform-Version': this.getParam('platformVersion'),
            'X-Protocol-Version': this.getParam('protocolVersion'),
            'X-Provider-Name': this.getParam('providerName'),
            'X-SDK-Version': this.getParam('sdkVersion')
        };
    }

    mapTokenResponse(statusCode, payload) {
        const { accessToken, refreshToken } = extractTokenPayload(payload);
        if (statusCode >= 200 && statusCode < 300 && (refreshToken || accessToken)) {
            return {
                status: STATUS.CONFIRMED,
                accessToken,
                refreshToken
            };
        }

        const error = normalizeToken(payload?.error).toLowerCase();
        if (error === 'authorization_pending' || error === 'slow_down') {
            return { status: STATUS.NEW };
        }
        if (error === 'access_denied') {
            return { status: STATUS.CANCELED };
        }
        if (error.includes('expired') || error === 'invalid_grant') {
            return { status: STATUS.EXPIRED };
        }

        return { status: STATUS.NEW };
    }

    stringifyTokenPayload(payload) {
        return normalizeToken(payload?.refreshToken || payload?.accessToken);
    }

    async requestDeviceCode(deviceId) {
        const response = await this.request({
            method: 'POST',
            url: this.getEndpoint('deviceCode'),
            data: {
                scope: this.getParam('scope'),
                client_id: this.getClientId()
            },
            headers: this.buildAccountHeaders(deviceId),
            validateStatus: () => true
        });

        const payload = normalizeResponseData(response.data);
        const deviceCode = normalizeToken(payload?.device_code);
        const verifyUrl = normalizeToken(
            payload?.verification_uri_complete || payload?.verification_url
        );
        const expiresIn = Number(payload?.expires_in || 120);

        if (response.status < 200 || response.status >= 300 || !deviceCode || !verifyUrl) {
            throw new Error(
                payload?.error_description || payload?.message || `status=${response.status}`
            );
        }

        return {
            deviceCode,
            verifyUrl,
            expiresIn
        };
    }

    async queryDeviceToken(sessionData) {
        const response = await this.request({
            method: 'POST',
            url: this.getEndpoint('token'),
            data: {
                grant_type: this.getParam('deviceCodeGrantType'),
                device_code: sessionData.deviceCode,
                client_id: this.getClientId()
            },
            headers: this.buildAccountHeaders(sessionData.deviceId),
            validateStatus: () => true
        });

        return this.mapTokenResponse(response.status, normalizeResponseData(response.data));
    }

    async generateQRCode() {
        try {
            const deviceId = this.createDeviceId();
            const deviceCodeData = await this.requestDeviceCode(deviceId);
            const sessionKey = this.createSessionKey(
                {
                    deviceId,
                    deviceCode: deviceCodeData.deviceCode
                },
                Math.max(1000, deviceCodeData.expiresIn * 1000)
            );
            const qrcode = await this.generateQRCodeImage(deviceCodeData.verifyUrl);

            return this.createSuccessResponse({
                qrcode,
                sessionKey
            });
        } catch (error) {
            return this.createErrorResponse('生成二维码失败: ' + error.message);
        }
    }

    async checkStatus(sessionKey) {
        try {
            const sessionData = this.parseSessionKey(sessionKey);
            if (!sessionData) {
                return this.createSuccessResponse({ status: STATUS.EXPIRED });
            }

            const result = await this.queryDeviceToken(sessionData);
            if (result.status === STATUS.CONFIRMED) {
                return this.createSuccessResponse({
                    status: STATUS.CONFIRMED,
                    cookie: this.stringifyTokenPayload(result)
                });
            }

            return this.createSuccessResponse({ status: result.status });
        } catch (error) {
            console.error('[guangyapan] 检查状态失败:', error.message);
            return this.createSuccessResponse({ status: STATUS.NEW });
        }
    }
}
