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

Keep ALL files and folders together, especially the app folder.
Do not open app\index.html directly. The shortcut starts a loopback-only local server.
Repeated launches reuse that server. It remains in the background until Windows
sign-out/restart. Start the shortcut again after restarting the laptop.
If the project folder is moved, recreate the Desktop shortcut.

The Android screen acts as the laptop's display. It must accept a video input
(e.g. HDMI IN). If using the screen's touch input, a separate USB touch connection
may be needed. A screen camera also needs a USB/data connection visible to Windows.
HDMI alone does not connect the screen's camera to the laptop.

All processing uses the local browser. Models, scripts, and test images are bundled.
External page requests are blocked by the application's Content Security Policy.

CAMERA SETTINGS (staff): press Ctrl+Alt+C in the app (or add ?camera to the address).
It shows the real camera resolution (should be 3840x2160 for the EMEET S600) and the
camera's exposure/focus controls. "Face-metered auto exposure" keeps the face evenly lit.
"Camera auto (reset)" returns everything to the camera's own automatic mode.

Validation: the launcher is started and checked on a Windows runner on every change
(health check, page, WebAssembly and model files). Camera behaviour still needs a
first-run check on the actual laptop and camera.
