/**
 * Paths under `public/` (served at site root in dev and copied to dist in build).
 * Adjust filenames to match your exported textures.
 */
export const AssetPaths = {
  ocean: {
    baseColor: "/assets/textures/ocean/ocean.png",
    normal: "/assets/textures/ocean/ocean_normal.png",
    height: "/assets/textures/ocean/ocean_heightmap.png",
    foamMask: "/assets/textures/ocean/foam-mask.png",
  },
} as const;
