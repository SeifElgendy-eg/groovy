GROOVY - WINDOWS OFFLINE

1. Extract the entire ZIP to a permanent local folder on the Windows laptop.
   Do not run files directly inside the ZIP.
2. Double-click "Create Desktop Shortcut.vbs" once.
3. Double-click the Groovy shortcut on your Desktop to start.
   "Start Groovy.vbs" also starts the app directly.
4. Allow camera access in Edge/Chrome on the first camera use.

No Python, Node, terminal commands or Internet connection are required at runtime.
Requires Windows PowerShell 5.1, Windows Script Host, and a recent Edge or Chrome.
Managed laptops may restrict scripts; do not change company policy to bypass a block.
The process-level execution-policy argument does not change your Windows policy.

Keep ALL files and folders together, especially models and vendor.
Do not open index.html directly. The shortcut starts a loopback-only local server.
Repeated launches reuse that server. It remains in the background until Windows
sign-out/restart. Start the shortcut again after restarting the laptop.
If the project folder is moved, recreate the Desktop shortcut.

The Android screen acts as the laptop's display. It must accept a video input
(e.g. HDMI IN). If using the screen's touch input, a separate USB touch connection
may be needed. A screen camera also needs a USB/data connection visible to Windows.
HDMI alone does not connect the screen's camera to the laptop.

All processing uses the local browser. Models, scripts, and test images are bundled.
External page requests are blocked by the application's Content Security Policy.

Validation: local browser/model and photo processing checked on macOS;
Windows launcher still requires a first-run check on the actual Windows laptop.
