import { logger } from "../logger"

// Persistent cache for channel resolution mappings (handle → UC ID, UC ID → Target)
// This survives page reloads and helps avoid YouTube's personalization issues

// This should only work in extension contexts (pages or service worker)
if (typeof chrome === 'undefined' || typeof chrome.runtime === 'undefined') {
    throw new Error("YT channelCache can only be accessed from extension windows and service workers.")
}

const CACHE_VERSION = 1
const DB_NAME = `yt-channel-cache-v${CACHE_VERSION}`
const HANDLE_STORE = "handles" // Maps @handle → UC ID
const UC_STORE = "ucs" // Maps UC ID → Target
const YTURL_STORE = "yturls" // Maps YT URL (e.g. /@veritasium) → UC ID

type Target = { id: string, type: 'video' | 'channel' }

let db = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof self.indexedDB !== 'undefined') {
        const openRequest = indexedDB.open(DB_NAME, CACHE_VERSION)
        openRequest.addEventListener('upgradeneeded', () => {
            const database = openRequest.result
            // Create stores if they don't exist
            if (!database.objectStoreNames.contains(HANDLE_STORE)) {
                const handleStore = database.createObjectStore(HANDLE_STORE)
                handleStore.createIndex("expireAt", "expireAt")
            }
            if (!database.objectStoreNames.contains(UC_STORE)) {
                const ucStore = database.createObjectStore(UC_STORE)
                ucStore.createIndex("expireAt", "expireAt")
            }
            if (!database.objectStoreNames.contains(YTURL_STORE)) {
                const ytUrlStore = database.createObjectStore(YTURL_STORE)
                ytUrlStore.createIndex("expireAt", "expireAt")
            }
        })
        openRequest.addEventListener('success', () => {
            resolve(openRequest.result)
            clearExpired()
        }, { once: true })
        openRequest.addEventListener('error', () => reject(openRequest.error))
    }
    else reject(`IndexedDB not supported`)
})

async function clearExpired() {
    try {
        const database = await db
        for (const storeName of [HANDLE_STORE, UC_STORE, YTURL_STORE]) {
            const transaction = database.transaction(storeName, "readwrite")
            const range = IDBKeyRange.upperBound(new Date())
            const expireAtCursorRequest = transaction.objectStore(storeName).index("expireAt").openCursor(range)

            await new Promise<void>((resolve, reject) => {
                expireAtCursorRequest.addEventListener('error', () => reject(expireAtCursorRequest.error))
                expireAtCursorRequest.addEventListener('success', () => {
                    try {
                        const expireCursor = expireAtCursorRequest.result
                        if (!expireCursor) {
                            resolve()
                            return
                        }
                        expireCursor.delete()
                        expireCursor.continue()
                    }
                    catch (ex) {
                        reject(ex)
                    }
                })
            })
        }
    } catch (error) {
        logger.error('Failed to clear expired channel cache entries:', error)
    }
}

async function clearAll() {
    const database = await db
    for (const storeName of [HANDLE_STORE, UC_STORE, YTURL_STORE]) {
        await new Promise<void>((resolve, reject) => {
            const store = database.transaction(storeName, "readwrite").objectStore(storeName)
            if (!store) return resolve()
            const request = store.clear()
            request.addEventListener('success', () => resolve())
            request.addEventListener('error', () => reject(request.error))
        })
    }
    logger.log('✅ Cleared all channel cache stores')
}

// Handle cache: Maps normalized handle (without @) → UC ID
async function putHandle(handle: string, ucId: string | null): Promise<void> {
    const normHandle = handle.startsWith('@') ? handle.slice(1) : handle
    return await new Promise(async (resolve, reject) => {
        const store = (await db).transaction(HANDLE_STORE, "readwrite").objectStore(HANDLE_STORE)
        if (!store) return resolve()
        // Shorter TTL for nulls to allow re-resolve sooner
        const ttlOkMs = 7 * 24 * 60 * 60 * 1000 // 7 days
        const ttlNullMs = 24 * 60 * 60 * 1000   // 24 hours
        const expireAt = new Date(Date.now() + (ucId ? ttlOkMs : ttlNullMs))
        const request = store.put({ value: ucId, expireAt }, normHandle)
        logger.debug('caching handle', normHandle, '→', ucId, 'until:', expireAt)
        request.addEventListener('success', () => resolve())
        request.addEventListener('error', () => reject(request.error))
    })
}

async function getHandle(handle: string): Promise<string | null | undefined> {
    const normHandle = handle.startsWith('@') ? handle.slice(1) : handle
    const response = (await new Promise(async (resolve, reject) => {
        const store = (await db).transaction(HANDLE_STORE, "readonly").objectStore(HANDLE_STORE)
        if (!store) return reject(`Can't find handle store.`)

        const request = store.get(normHandle)
        request.addEventListener('success', () => resolve(request.result))
        request.addEventListener('error', () => reject(request.error))
    }) as { value: string | null, expireAt: Date } | undefined)

    if (response === undefined) return undefined
    if (response.expireAt <= new Date()) {
        await clearExpired()
        return undefined
    }
    return response.value
}

// UC cache: Maps UC ID → Target
async function putUC(ucId: string, target: Target | null): Promise<void> {
    return await new Promise(async (resolve, reject) => {
        const store = (await db).transaction(UC_STORE, "readwrite").objectStore(UC_STORE)
        if (!store) return resolve()
        const ttlOkMs = 7 * 24 * 60 * 60 * 1000 // 7 days
        const ttlNullMs = 24 * 60 * 60 * 1000   // 24 hours
        const expireAt = new Date(Date.now() + (target ? ttlOkMs : ttlNullMs))
        const request = store.put({ value: target, expireAt }, ucId)
        logger.debug('caching UC', ucId, '→', target ? 'valid target' : 'null', 'until:', expireAt)
        request.addEventListener('success', () => resolve())
        request.addEventListener('error', () => reject(request.error))
    })
}

async function getUC(ucId: string): Promise<Target | null | undefined> {
    const response = (await new Promise(async (resolve, reject) => {
        const store = (await db).transaction(UC_STORE, "readonly").objectStore(UC_STORE)
        if (!store) return reject(`Can't find UC store.`)

        const request = store.get(ucId)
        request.addEventListener('success', () => resolve(request.result))
        request.addEventListener('error', () => reject(request.error))
    }) as { value: Target | null, expireAt: Date } | undefined)

    if (response === undefined) return undefined
    if (response.expireAt <= new Date()) {
        await clearExpired()
        return undefined
    }
    return response.value
}

// YT URL cache: Maps YouTube URL path (e.g. "/@veritasium") → UC ID
async function putYtUrl(ytUrl: string, ucId: string | null): Promise<void> {
    return await new Promise(async (resolve, reject) => {
        const store = (await db).transaction(YTURL_STORE, "readwrite").objectStore(YTURL_STORE)
        if (!store) return resolve()
        const ttlOkMs = 7 * 24 * 60 * 60 * 1000 // 7 days
        const ttlNullMs = 24 * 60 * 60 * 1000   // 24 hours
        const expireAt = new Date(Date.now() + (ucId ? ttlOkMs : ttlNullMs))
        const request = store.put({ value: ucId, expireAt }, ytUrl)
        logger.debug('caching ytUrl', ytUrl, '→', ucId, 'until:', expireAt)
        request.addEventListener('success', () => resolve())
        request.addEventListener('error', () => reject(request.error))
    })
}

async function getYtUrl(ytUrl: string): Promise<string | null | undefined> {
    const response = (await new Promise(async (resolve, reject) => {
        const store = (await db).transaction(YTURL_STORE, "readonly").objectStore(YTURL_STORE)
        if (!store) return reject(`Can't find ytUrl store.`)

        const request = store.get(ytUrl)
        request.addEventListener('success', () => resolve(request.result))
        request.addEventListener('error', () => reject(request.error))
    }) as { value: string | null, expireAt: Date } | undefined)

    if (response === undefined) return undefined
    if (response.expireAt <= new Date()) {
        await clearExpired()
        return undefined
    }
    return response.value
}

export const channelCache = {
    putHandle,
    getHandle,
    putUC,
    getUC,
    putYtUrl,
    getYtUrl,
    clearAll,
}
