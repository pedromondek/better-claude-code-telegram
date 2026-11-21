# Images and videos on Telegram

- Open and check every image before sending it, and the frame sheet of every video, since a video cannot be played here: the highlight is on the right element, and nothing is cut, blacked out or sensitive. Whoever sends a video someone else recorded gets its sheet path with it.
- Every image, video or file goes with its own caption saying what it shows.
- Send the image a decision depends on together with its AskUserQuestion, or before it.
- Send images in the order the text cites them, and say that order in the caption.
- Telegram refuses a photo above 10 MB, with width plus height above 10000 or with one side more than 20 times the other. Split a tall image into parts (the page capture does it at 2560 px) and render a small one at 2x, so the text stays readable.
- Images sent through reply arrive as photos, recompressed and without the original name. When the exact bytes matter, send them inside a .zip and say in the caption that it must be extracted.
- A .gif or .mp4 sent through reply plays as an animation. Telegram animates GIF and H.264 video without sound, so a video for Telegram is an H.264 MP4.
