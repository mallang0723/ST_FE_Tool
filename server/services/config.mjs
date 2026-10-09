import fs from 'node:fs/promises';
import path from 'node:path';
import {CONFIG_DEFAULTS} from '../../shared/contracts/index.mjs';
import {atomicJson,readDocument,serialized,userStore} from '../storage/documents.mjs';
const legacyKeys={settingsAccelerationEnabled:'baibaokuSettingsAccelerationEnabled',lazyThemeLoadingEnabled:'baibaokuLazyThemeLoadingEnabled',extensionManifestBundleEnabled:'extensionManifestBundleEnabled',characterListAccelerationEnabled:'fastCharacterListEnabled',recentChatListAccelerationEnabled:'recentChatListAccelerationEnabled',tokenizerBulkCountEnabled:'tokenizerBulkCountEnabled',chatKeyboardScanReductionEnabled:'chatKeyboardScanReductionEnabled',backupAutoCleanupEnabled:'presetBackupAutoCleanupEnabled',backupKeepCount:'presetBackupKeepCount'};
export async function uiEnabled(user){
    try{
        await fs.access(path.join(user.directories.extensions,'damso-tools/manifest.json'));
        const settings=JSON.parse(await fs.readFile(path.join(user.directories.root,'settings.json'),'utf8'));
        return !settings.extension_settings?.disabledExtensions?.includes('third-party/damso-tools');
    }catch{return false;}
}
export async function getConfig(user){
    const file=path.join(await userStore(user),'config.json');
    return serialized(file,async()=>{
        const current=await readDocument(user,'config',CONFIG_DEFAULTS);
        if(current.revision!==0)return {...CONFIG_DEFAULTS,...current};
        // Import only known preferences once. Never copy prompts, keys or arbitrary settings.
        let saved={};try{saved=JSON.parse(await fs.readFile(path.join(user.directories.root,'settings.json'),'utf8')).extension_settings?.baiBaiToolkit || {};}catch(error){if(error.code!=='ENOENT')throw error;}
        for(const [key,legacy]of Object.entries(legacyKeys))if(typeof saved[legacy]===typeof CONFIG_DEFAULTS[key])current[key]=saved[legacy];
        if(!Number.isSafeInteger(current.backupKeepCount)||current.backupKeepCount<1||current.backupKeepCount>100000)current.backupKeepCount=200;
        if(!current.settingsAccelerationEnabled)current.lazyThemeLoadingEnabled=false;
        current.progressiveChatLoadingEnabled=false;current.revision=1;await atomicJson(file,current);return current;
    });
}
