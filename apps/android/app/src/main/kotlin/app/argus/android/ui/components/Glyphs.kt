package app.argus.android.ui.components

import androidx.compose.material.icons.materialIcon
import androidx.compose.material.icons.materialPath
import androidx.compose.ui.graphics.vector.ImageVector

/**
 * The handful of Material glyphs the sidebar needs that
 * `material-icons-core` does not ship (the extended set is a 16 MB
 * artifact for three icons). Path data is the Material Design icon set
 * (Apache 2.0), transcribed the way `Attachments.kt` does for the
 * paperclip. Each is a lazy `ImageVector` so nothing is built until
 * first use.
 *
 * `Folder` is the OUTLINED folder (the web's lucide `Folder` and iOS's
 * SF `folder`), `Eye` / `EyeOff` are the per-project archive toggle
 * (web `Eye` / `EyeOff`, iOS `eye` / `eye.slash`).
 */
object ArgusGlyphs {
    val Folder: ImageVector by lazy {
        materialIcon(name = "Argus.FolderOutline") {
            materialPath {
                moveTo(20f, 6f)
                horizontalLineToRelative(-8f)
                lineToRelative(-2f, -2f)
                horizontalLineTo(4f)
                curveToRelative(-1.1f, 0f, -1.99f, 0.9f, -1.99f, 2f)
                lineTo(2f, 18f)
                curveToRelative(0f, 1.1f, 0.9f, 2f, 2f, 2f)
                horizontalLineToRelative(16f)
                curveToRelative(1.1f, 0f, 2f, -0.9f, 2f, -2f)
                verticalLineTo(8f)
                curveToRelative(0f, -1.1f, -0.9f, -2f, -2f, -2f)
                close()
                moveTo(20f, 18f)
                horizontalLineTo(4f)
                verticalLineTo(8f)
                horizontalLineToRelative(16f)
                verticalLineToRelative(10f)
                close()
            }
        }
    }

    val Eye: ImageVector by lazy {
        materialIcon(name = "Argus.Eye") {
            materialPath {
                moveTo(12f, 4.5f)
                curveTo(7f, 4.5f, 2.73f, 7.61f, 1f, 12f)
                curveToRelative(1.73f, 4.39f, 6f, 7.5f, 11f, 7.5f)
                reflectiveCurveToRelative(9.27f, -3.11f, 11f, -7.5f)
                curveToRelative(-1.73f, -4.39f, -6f, -7.5f, -11f, -7.5f)
                close()
                moveTo(12f, 17f)
                curveToRelative(-2.76f, 0f, -5f, -2.24f, -5f, -5f)
                reflectiveCurveToRelative(2.24f, -5f, 5f, -5f)
                reflectiveCurveToRelative(5f, 2.24f, 5f, 5f)
                reflectiveCurveToRelative(-2.24f, 5f, -5f, 5f)
                close()
                moveTo(12f, 9f)
                curveToRelative(-1.66f, 0f, -3f, 1.34f, -3f, 3f)
                reflectiveCurveToRelative(1.34f, 3f, 3f, 3f)
                reflectiveCurveToRelative(3f, -1.34f, 3f, -3f)
                reflectiveCurveToRelative(-1.34f, -3f, -3f, -3f)
                close()
            }
        }
    }

    val EyeOff: ImageVector by lazy {
        materialIcon(name = "Argus.EyeOff") {
            materialPath {
                moveTo(12f, 7f)
                curveToRelative(2.76f, 0f, 5f, 2.24f, 5f, 5f)
                curveToRelative(0f, 0.65f, -0.13f, 1.26f, -0.36f, 1.83f)
                lineToRelative(2.92f, 2.92f)
                curveToRelative(1.51f, -1.26f, 2.7f, -2.89f, 3.43f, -4.75f)
                curveToRelative(-1.73f, -4.39f, -6f, -7.5f, -11f, -7.5f)
                curveToRelative(-1.4f, 0f, -2.74f, 0.25f, -3.98f, 0.7f)
                lineToRelative(2.16f, 2.16f)
                curveTo(10.74f, 7.13f, 11.35f, 7f, 12f, 7f)
                close()
                moveTo(2f, 4.27f)
                lineToRelative(2.28f, 2.28f)
                lineToRelative(0.46f, 0.46f)
                curveTo(3.08f, 8.3f, 1.78f, 10.02f, 1f, 12f)
                curveToRelative(1.73f, 4.39f, 6f, 7.5f, 11f, 7.5f)
                curveToRelative(1.55f, 0f, 3.03f, -0.3f, 4.38f, -0.84f)
                lineToRelative(0.42f, 0.42f)
                lineTo(19.73f, 22f)
                lineTo(21f, 20.73f)
                lineTo(3.27f, 3f)
                lineTo(2f, 4.27f)
                close()
                moveTo(7.53f, 9.8f)
                lineToRelative(1.55f, 1.55f)
                curveToRelative(-0.05f, 0.21f, -0.08f, 0.43f, -0.08f, 0.65f)
                curveToRelative(0f, 1.66f, 1.34f, 3f, 3f, 3f)
                curveToRelative(0.22f, 0f, 0.44f, -0.03f, 0.65f, -0.08f)
                lineToRelative(1.55f, 1.55f)
                curveToRelative(-0.67f, 0.33f, -1.41f, 0.53f, -2.2f, 0.53f)
                curveToRelative(-2.76f, 0f, -5f, -2.24f, -5f, -5f)
                curveToRelative(0f, -0.79f, 0.2f, -1.53f, 0.53f, -2.2f)
                close()
                moveTo(11.84f, 9.02f)
                lineToRelative(3.15f, 3.15f)
                lineToRelative(0.02f, -0.16f)
                curveToRelative(0f, -1.66f, -1.34f, -3f, -3f, -3f)
                lineToRelative(-0.17f, 0.01f)
                close()
            }
        }
    }
}
