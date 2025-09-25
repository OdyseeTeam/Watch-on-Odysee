import { h, render } from 'preact'
import { useState } from 'preact/hooks'
import { odyseeUrlCache } from '../../modules/yt/urlCache'
import { logger } from '../../modules/logger'
import { setExtensionSetting, targetPlatformSettings, useExtensionSettings } from '../../settings'

function WatchOnOdyseePopup(params: {}) {
  const { redirectVideo, redirectChannel, buttonVideoSub, buttonChannelSub, buttonVideoPlayer, buttonOverlay, resultsApplySelections } = useExtensionSettings()
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
              <button type='button' onClick={() => setExtensionSetting('redirectVideo', !redirectVideo)} className={`button ${redirectVideo ? 'active' : ''}`} aria-pressed={redirectVideo}>
                {redirectVideo ? 'Active' : 'Deactive'}
              </button>
            </div>
            <div class="toggle-option">
              <span>Viewing a channel</span>
              <button type='button' onClick={() => setExtensionSetting('redirectChannel', !redirectChannel)} className={`button ${redirectChannel ? 'active' : ''}`} aria-pressed={redirectChannel}>
                {redirectChannel ? 'Active' : 'Deactive'}
              </button>
            </div>
          </div>
        </section>
        <section>
          <label>Show redirect option for:</label>
          <div className='options'>
            <div className="toggle-option">
              <span>Videos</span>
              <button type='button' onClick={() => setExtensionSetting('buttonVideoSub', !buttonVideoSub)} className={`button ${buttonVideoSub ? 'active' : ''}`} aria-pressed={buttonVideoSub}>
                {buttonVideoSub ? 'Active' : 'Deactive'}
              </button>
            </div>
            <div className="toggle-option">
              <span>Channels</span>
              <button type='button' onClick={() => setExtensionSetting('buttonChannelSub', !buttonChannelSub)} className={`button ${buttonChannelSub ? 'active' : ''}`} aria-pressed={buttonChannelSub}>
                {buttonChannelSub ? 'Active' : 'Deactive'}
              </button>
            </div>
            <div className="toggle-option">
              <span>Video Player</span>
              <button type='button' onClick={() => setExtensionSetting('buttonVideoPlayer', !buttonVideoPlayer)} className={`button ${buttonVideoPlayer ? 'active' : ''}`} aria-pressed={buttonVideoPlayer}>
                {buttonVideoPlayer ? 'Active' : 'Deactive'}
              </button>
            </div>
            <div className="toggle-option">
              <span>Video Previews</span>
              <button type='button' onClick={() => setExtensionSetting('buttonOverlay', !buttonOverlay)} className={`button ${buttonOverlay ? 'active' : ''}`} aria-pressed={buttonOverlay}>
                {buttonOverlay ? 'Active' : 'Deactive'}
              </button>
            </div>
          </div>
        </section>
        <section>
          <label>Search Results</label>
          <div className='options'>
            <div className="toggle-option">
              <span>Apply selections to Search Results</span>
              <button type='button' onClick={() => setExtensionSetting('resultsApplySelections', !resultsApplySelections)} className={`button ${resultsApplySelections ? 'active' : ''}`} aria-pressed={resultsApplySelections}>
                {resultsApplySelections ? 'Active' : 'Deactive'}
              </button>
            </div>
          </div>
        </section>
        <section>
          <label>Tools</label>
          <button type='button' onClick={() => loads(odyseeUrlCache.clearAll())} className={`button active`}>
            Clear Resolver Cache
          </button>
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
