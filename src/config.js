// Google OAuth client for the PC (browser) version, from the Google Cloud Console
// ("Credentials" > OAuth client ID > Web application). Not a secret: it only works
// on the page addresses listed in that client. The Android app does not need it.
export const GOOGLE_WEB_CLIENT_ID = '403103856875-qq1t9g0n0m0bcm1cn12nt3nopc7fqc0v.apps.googleusercontent.com';

// Firebase (Firestore) for the shared expenses tab. The web API key is not a secret:
// access to the data is decided by the Firestore security rules in the Firebase console.
// Empty key = the shared tab is not available in this build.
export const FIREBASE_API_KEY = 'AIzaSyDQrnLfxs4NCMBOCNjxps56celpmdn24Lo';
export const FIREBASE_PROJECT = 'livro-de-contas-515111';
