import { h, render } from 'preact'
import { useState } from 'preact/hooks'
import { odyseeUrlCache } from '../../modules/yt/urlCache'
import { logger } from '../../modules/logger'
import { setExtensionSetting, targetPlatformSettings, useExtensionSettings } from '../../settings'

function WatchOnOdyseePopup(params: {}) {
  const { redirectVideo, redirectChannel, buttonVideoSub, buttonChannelSub, buttonVideoPlayer, buttonOverlay } = useExtensionSettings()
  let [loading, updateLoading] = useState(() => false)

  async function loads<T>(operation: Promise<T>) {
    try {
      updateLoading(true)
      await operation
    } catch (error) {
      logger.error(error)
    }
    finally {
      updateLoading(false)
    }
  }

  return <div id='popup'>
    
    {
      <header>
        <img id="logo" src={targetPlatformSettings.odysee.button.icon}></img>
        <h1>Watch on Odysee</h1>
      </header>
    }
    {
      <main>
        <section>
          <label>Auto redirect when:</label>
          <div className='options'>
            <div class="toggle-option">
              <span>Playing a video</span>
              <a onClick={() => setExtensionSetting('redirectVideo', !redirectVideo)} className={`button ${redirectVideo ? 'active' : ''}`}>
                {redirectVideo ? 'Active' : 'Deactive'}
              </a>
            </div>
            <div class="toggle-option">
              <span>Viewing a channel</span>
              <a onClick={() => setExtensionSetting('redirectChannel', !redirectChannel)} className={`button ${redirectChannel ? 'active' : ''}`}>
                {redirectChannel ? 'Active' : 'Deactive'}
              </a>
            </div>
          </div>
        </section>
        <section>
          <label>Show redirect option for:</label>
          <div className='options'>
            <div className="toggle-option">
              <span>Videos</span>
              <a onClick={() => setExtensionSetting('buttonVideoSub', !buttonVideoSub)} className={`button ${buttonVideoSub ? 'active' : ''}`}>
                {buttonVideoSub ? 'Active' : 'Deactive'}
              </a>
            </div>
            <div className="toggle-option">
              <span>Channels</span>
              <a onClick={() => setExtensionSetting('buttonChannelSub', !buttonChannelSub)} className={`button ${buttonChannelSub ? 'active' : ''}`}>
                {buttonChannelSub ? 'Active' : 'Deactive'}
              </a>
            </div>
            <div className="toggle-option">
              <span>Video Player</span>
              <a onClick={() => setExtensionSetting('buttonVideoPlayer', !buttonVideoPlayer)} className={`button ${buttonVideoPlayer ? 'active' : ''}`}>
                {buttonVideoPlayer ? 'Active' : 'Deactive'}
              </a>
            </div>
            <div className="toggle-option">
              <span>Video Previews</span>
              <a onClick={() => setExtensionSetting('buttonOverlay', !buttonOverlay)} className={`button ${buttonOverlay ? 'active' : ''}`}>
                {buttonOverlay ? 'Active' : 'Deactive'}
              </a>
            </div>
          </div>
        </section>
        <section>
          <label>Tools</label>
          <a onClick={() => loads(odyseeUrlCache.clearAll())} className={`button active`}>
            Clear Resolver Cache
          </a>
        </section>
      </main>
    }
    {loading && <div class="overlay">
      <span>Loading...</span>
    </div>}
  </div>
}

function renderPopup() {
  render(<WatchOnOdyseePopup />, document.getElementById('root')!)
}

renderPopup()
