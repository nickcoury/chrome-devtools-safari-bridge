export const compatibilityMatrix = {
  desktop: {
    verifiedCombos: [
      {
        safari: "26.4",
        chrome: "146.0.7680.165",
        notes: "Verified on macOS 15.7.5 with the desktop bridge, Elements, mapped async breakpoints, and desktop verifier.",
      },
    ],
    verifiedSafariMajors: ["26"],
    verifiedChromeMajors: ["146"],
  },
};

function majorOf(version) {
  return String(version || "").split(".")[0] || "";
}

export function assessDesktopCompatibility({ safariVersion, chromeVersion }) {
  const exactMatch = compatibilityMatrix.desktop.verifiedCombos.find(
    (entry) => entry.safari === safariVersion && entry.chrome === chromeVersion,
  );
  if (exactMatch) {
    return {
      status: "verified",
      summary: `Verified combo: Safari ${safariVersion} with Chrome ${chromeVersion}.`,
      notes: exactMatch.notes,
    };
  }

  const safariMajor = majorOf(safariVersion);
  const chromeMajor = majorOf(chromeVersion);
  const safariMajorKnown = compatibilityMatrix.desktop.verifiedSafariMajors.includes(safariMajor);
  const chromeMajorKnown = compatibilityMatrix.desktop.verifiedChromeMajors.includes(chromeMajor);

  if (safariMajorKnown && chromeMajorKnown) {
    return {
      status: "likely",
      summary: `Unverified patch-level combo: Safari ${safariVersion} with Chrome ${chromeVersion}.`,
      notes:
        "Both major versions match a verified combination, but this exact patch-level pair has not been regression-verified yet. Run `npm run verify:desktop`.",
    };
  }

  if (!chromeVersion) {
    return {
      status: "unknown",
      summary: `Safari ${safariVersion} detected, but Google Chrome was not detected in /Applications.`,
      notes:
        "Chrome DevTools frontend compatibility is unknown without a local Chrome install. Install Google Chrome or open the DevTools frontend from another compatible Chromium build manually.",
    };
  }

  return {
    status: "unverified",
    summary: `Unverified desktop combo: Safari ${safariVersion} with Chrome ${chromeVersion}.`,
    notes:
      "This Safari/Chrome version pair is outside the combinations currently verified in this repo. The bridge may still work, but run `npm run verify:desktop` and expect possible DevTools frontend drift.",
  };
}
