# App Store Connect Review Counter

A tiny Chrome extension that shows the **actual number of ratings per star** on App Store Connect's Ratings and Reviews page.

Apple only shows the bar chart, but each bar's fill element carries a full-precision width percentage. Combined with the total ("113 Ratings"), the exact per-star counts can be recovered. This extension annotates each bar with its count and shows a tooltip with the percentage on hover.

## Install

1. Clone or download this repo.
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode** (top right).
4. Click **Load unpacked** and select this folder.
5. Open your app's page at `https://appstoreconnect.apple.com/apps/<app-id>/distribution/ratings/ios` — counts appear to the right of each bar.

## How it works

- A content script watches the page (the chart loads asynchronously) for the star-rating rows (`div[role="img"]` with an aria-label like `5 Stars 80.5%`).
- It reads the full-precision bar width (e.g. `80.53097345132744%`), falling back to the aria-label percentage if the width attribute is malformed.
- It finds the "N Ratings" total in the same chart and apportions counts with the largest-remainder method so they always sum exactly to the total.

## License

MIT
