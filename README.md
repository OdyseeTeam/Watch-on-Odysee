## Looking for contributors :)
# Watch on Odysee
![WOO_marquee promo tile 1400x560](https://user-images.githubusercontent.com/16674412/120082996-48100880-c0c6-11eb-83fe-526847c48026.jpg)

A plugin that helps you remmeber to watch content on Odysee while you're on YouTube and a few of their open frontends like newpipe,etc. 
# Privacy

This extension does not collect, transmit, sell, or share personal data. Settings are stored locally using the browser's extension storage, and a small IndexedDB cache maps YouTube IDs to Odysee paths to improve performance. You can clear the cache from the popup at any time. See `doc/PRIVACY.md` for full details.

## Installation

[![Get it on Firefox](doc/img/AMO-button_1.png)](https://addons.mozilla.org/en/firefox/addon/watch-on-odysee/)
[![Get it on Chrome](doc/img/chrome-small-border.png)](https://chrome.google.com/webstore/detail/watch-on-odysee/kofmhmemalhemmpkfjhjfkkhifonoann?hl=en&authuser=0)

## Build

From the root of the project

For Production
```bash
$ npm install
$ npm run build
$ npm run build:webext  # optional, to create the zip file from the dist directory
```

For Development
```bash
$ npm install
$ npm run watch
```

Then, either manually install it for your browser or, from another terminal invoke:

```bash
$ npm run start:chrome
$ npm run start:firefox # or, if you'd prefer firefox
```

### Manual Install for Chrome:
Visit ```chrome://extensions``` (via omnibox or menu -> Tools -> Extensions).
Enable Developer mode by ticking the checkbox in the upper-right corner.
Click on the "Load unpacked extension..." button.
Select the directory containing your unpacked extension.
### Manual Install for Firefox
To install an extension temporarily:

-   open Firefox
-   enter “about:debugging” in the URL bar
-   click “Load Temporary Add-on”
-   open the extension’s directory and select any file inside the extension.

The extension will be installed, and will stay installed until you restart Firefox.


## Usage

Go to YouTube in your browser. When you load a video or channel, it will detect if it's also uploaded to the Odysee and the it will move you to odysee.com so you can watch the video on Odysee

## Contributing
Pull requests are welcome. For major changes, please open an issue first to discuss what you would like to change.

Please make sure to update tests as appropriate.

## License
[GPL-3.0 License](LICENSE)

## Support

If you want you can donate me with crypto :)

LBC : bXeBKSjPygVbvkBH79Bp6CxiyeRC2hpVQ3


This will help future plugin development :)
