import { QuarkPlatform } from './quark.js';
import { UCPlatform } from './uc.js';
import { UCTokenPlatform } from './uc-token.js';
import { AliPlatform } from './ali.js';
import { Platform115 } from './115.js';
import { BaiduPlatform } from './baidu.js';
import { BilibiliPlatform } from './bilibili.js';
import { GuangYaPanPlatform } from './guangyapan.js';

/**
 * 平台工厂类 - 负责创建和管理平台实例
 */
class PlatformFactory {
    constructor() {
        // 平台映射表
        this.platforms = {
            'quark': QuarkPlatform,
            'uc': UCPlatform,
            'uc_token': UCTokenPlatform,
            'ali': AliPlatform,
            '115': Platform115,
            'baidu': BaiduPlatform,
            'bilibili': BilibiliPlatform,
            'guangyapan': GuangYaPanPlatform
        };
        
        // 实例缓存
        this.instances = new Map();
    }

    /**
     * 创建平台实例
     * @param {string} platformName 平台名称
     * @returns {BasePlatform} 平台实例
     */
    create(platformName) {
        if (!platformName) {
            throw new Error('平台名称不能为空');
        }

        // 检查是否支持该平台
        const PlatformClass = this.platforms[platformName];
        if (!PlatformClass) {
            throw new Error(`不支持的平台: ${platformName}`);
        }

        // 使用单例模式，避免重复创建实例
        if (!this.instances.has(platformName)) {
            this.instances.set(platformName, new PlatformClass());
        }

        return this.instances.get(platformName);
    }

    /**
     * 获取所有支持的平台列表
     * @returns {Array<string>} 平台名称列表
     */
    getSupportedPlatforms() {
        return Object.keys(this.platforms);
    }

    /**
     * 检查是否支持指定平台
     * @param {string} platformName 平台名称
     * @returns {boolean} 是否支持
     */
    isSupported(platformName) {
        return this.platforms.hasOwnProperty(platformName);
    }

    /**
     * 清除实例缓存
     */
    clearCache() {
        this.instances.clear();
    }
}

// 导出单例实例
export const platformFactory = new PlatformFactory();

// 也导出类，便于测试
export { PlatformFactory };
