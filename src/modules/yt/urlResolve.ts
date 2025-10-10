import { chunk } from "lodash"
import path from "path"
import { getExtensionSettingsAsync, ytUrlResolversSettings } from "../../settings"
import { odyseeUrlCache } from "./urlCache"

const QUERY_CHUNK_SIZE = 100

export type ResolveUrlTypes = 'video' | 'channel'
export type YtUrlResolveItem = { type: ResolveUrlTypes, id: string }
type Results = Record<string, YtUrlResolveItem>
type Paramaters = YtUrlResolveItem[]

interface ApiResponse {
    data: {
        channels?: Record<string, string>
        videos?: Record<string, string>
    }
}

export async function resolveById(params: Paramaters, progressCallback?: (progress: number) => void): Promise<Results> {
    const { urlResolver: urlResolverSettingName } = await getExtensionSettingsAsync()
    const urlResolverSetting = ytUrlResolversSettings[urlResolverSettingName]

    async function requestChunk(params: Paramaters) {
        const results: Results = {}

        // Check for cache first, add them to the results if there are any cache
        // And remove them from the params, so we dont request for them
        params = (await Promise.all(params.map(async (item) => {
            const cachedOdyseeUrl = await odyseeUrlCache.get(item.id)

            // Cache can be null, if there is no odysee url yet
            if (cachedOdyseeUrl !== undefined) {
                // Null values shouldn't be in the results
                if (cachedOdyseeUrl !== null) results[item.id] = { id: cachedOdyseeUrl, type: item.type }
                return null
            }

            // No cache found
            return item
        }))).filter((o) => o) as Paramaters

        if (params.length === 0) return results

        const url = new URL(`${urlResolverSetting.href}`)
        url.pathname = path.join(url.pathname, '/resolve')
        url.searchParams.set('video_ids', params.filter((item) => item.type === 'video').map((item) => item.id).join(','))
        url.searchParams.set('channel_ids', params.filter((item) => item.type === 'channel').map((item) => item.id).join(','))

        const controller = new AbortController()
        // 5 second timeout:
        const timeoutId = setTimeout(() => controller.abort(), 5000)
        const apiResponse = await fetch(url.toString(), { cache: 'no-store', signal: controller.signal })
        clearTimeout(timeoutId)
        
        if (apiResponse.ok) {
            const response: ApiResponse = await apiResponse.json()
            for (const item of params) {
                const odyseeUrl = (item.type === 'channel' ? response.data.channels : response.data.videos)?.[item.id]?.replaceAll('#', ':') ?? null
                // we cache it no matter if its null or not
                await odyseeUrlCache.put(odyseeUrl, item.id)

                if (odyseeUrl) results[item.id] = { id: odyseeUrl, type: item.type }
            }
        }

        return results
    }

    const results: Results = {}
    const chunks = chunk(params, QUERY_CHUNK_SIZE)

    let i = 0
    if (progressCallback) progressCallback(0)
    for (const chunk of chunks) {
        if (progressCallback) progressCallback(++i / (chunks.length + 1))
        Object.assign(results, await requestChunk(chunk))
    }

    if (progressCallback) progressCallback(1)
    return results
}
