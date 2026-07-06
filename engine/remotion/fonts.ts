// Default brand fonts (Cormorant Garamond + DM Sans). Loaded via @remotion/google-fonts so
// Chromium actually has the faces at render time (setting a family name is not enough).
import { loadFont as loadCormorant } from "@remotion/google-fonts/CormorantGaramond";
import { loadFont as loadDMSans } from "@remotion/google-fonts/DMSans";

// Cormorant Garamond: elegant editorial serif. Load normal + italic (the gold truth line is italic).
loadCormorant("normal", { weights: ["400", "500", "600"], subsets: ["latin"] });
const cormorant = loadCormorant("italic", { weights: ["500", "600"], subsets: ["latin"] });

// DM Sans: clean modern sans for eyebrows, list body, captions.
const dmSans = loadDMSans("normal", { weights: ["400", "500", "700"], subsets: ["latin"] });

export const SERIF = cormorant.fontFamily; // "Cormorant Garamond"
export const SANS = dmSans.fontFamily; // "DM Sans"
