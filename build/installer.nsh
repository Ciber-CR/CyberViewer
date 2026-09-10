; CyberViewer NSIS customizations (electron-builder include)
; - Optional "Set as default image viewer" page (checked by default)
; - Per-user HKCU associations when the option is enabled
; - Cleanup on uninstall
;
; electron-builder compiles this script twice (installer + uninstaller with
; BUILD_UNINSTALLER) and treats NSIS warnings as errors. Rules of thumb:
; - No unused `Var` (use $R8/$R9 for the checkbox page instead)
; - Guard install-only Page/Functions with !ifndef BUILD_UNINSTALLER
; - Avoid MUI_HEADER_TEXT (not always defined in this include context)

!include "nsDialogs.nsh"
!include "LogicLib.nsh"

; LangStrings for custom page localization
LangString CV_DefaultViewerTitle 1033 "Default image viewer"
LangString CV_DefaultViewerTitle 3082 "Visor de imágenes predeterminado"

LangString CV_DefaultViewerBody 1033 "CyberViewer can open JPG, JPEG, PNG, GIF, WEBP, BMP, TIFF and ICO.$\r$\n$\r$\nCheck the option below to use CyberViewer as your default image viewer for these formats (current user).$\r$\n$\r$\nYou can change defaults later in Windows Settings > Apps > Default apps."
LangString CV_DefaultViewerBody 3082 "CyberViewer puede abrir JPG, JPEG, PNG, GIF, WEBP, BMP, TIFF e ICO.$\r$\n$\r$\nMarca la opción de abajo para usar CyberViewer como tu visor de imágenes predeterminado para estos formatos (usuario actual).$\r$\n$\r$\nPuedes cambiar esta configuración más tarde en la Configuración de Windows > Aplicaciones > Aplicaciones predeterminadas."

LangString CV_DefaultViewerCheckbox 1033 "Set CyberViewer as the default image viewer"
LangString CV_DefaultViewerCheckbox 3082 "Establecer CyberViewer como el visor de imágenes predeterminado"

; $R9 = set-as-default flag (1 = yes, 0 = no). Default ON for silent installs.
!macro customInit
  StrCpy $R9 1
!macroend

; Shown after directory page, before files are installed (installer pass only)
!macro customPageAfterChangeDir
  !ifndef BUILD_UNINSTALLER
    Page custom CV_DefaultViewerPage_Show CV_DefaultViewerPage_Leave
  !endif
!macroend

!ifndef BUILD_UNINSTALLER
Function CV_DefaultViewerPage_Show
  ; In-app updates run the Setup with /S. Custom pages can still appear
  ; unless we abort when silent — keep the wizard for manual installs only.
  IfSilent 0 +2
  Abort

  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 18u "$(CV_DefaultViewerTitle)"
  Pop $1

  ${NSD_CreateLabel} 0 20u 100% 50u "$(CV_DefaultViewerBody)"
  Pop $2

  ${NSD_CreateCheckbox} 0 78u 100% 14u "$(CV_DefaultViewerCheckbox)"
  Pop $R8
  ${NSD_Check} $R8

  nsDialogs::Show
FunctionEnd

Function CV_DefaultViewerPage_Leave
  ; 1 = checked, 0 = unchecked
  ${NSD_GetState} $R8 $R9
FunctionEnd
!endif

; Write a single ProgID + extension default under HKCU (current user)
!macro CV_WriteImageAssoc EXT PROGID DESC
  WriteRegStr HKCU "Software\Classes\${PROGID}" "" "${DESC}"
  WriteRegStr HKCU "Software\Classes\${PROGID}\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Classes\${PROGID}\shell" "" "open"
  WriteRegStr HKCU "Software\Classes\${PROGID}\shell\open" "" "Open"
  WriteRegStr HKCU "Software\Classes\${PROGID}\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
  WriteRegStr HKCU "Software\Classes\${EXT}" "" "${PROGID}"
  WriteRegStr HKCU "Software\Classes\${EXT}\OpenWithProgids" "${PROGID}" ""
!macroend

!macro customInstall
  ; Only when user left the checkbox checked (or silent install default)
  ${If} $R9 == 1
    !insertmacro CV_WriteImageAssoc ".jpg"  "CyberViewer.jpg"  "JPEG Image"
    !insertmacro CV_WriteImageAssoc ".jpeg" "CyberViewer.jpg"  "JPEG Image"
    !insertmacro CV_WriteImageAssoc ".png"  "CyberViewer.png"  "PNG Image"
    !insertmacro CV_WriteImageAssoc ".gif"  "CyberViewer.gif"  "GIF Image"
    !insertmacro CV_WriteImageAssoc ".webp" "CyberViewer.webp" "WebP Image"
    !insertmacro CV_WriteImageAssoc ".bmp"  "CyberViewer.bmp"  "BMP Image"
    !insertmacro CV_WriteImageAssoc ".tif"  "CyberViewer.tiff" "TIFF Image"
    !insertmacro CV_WriteImageAssoc ".tiff" "CyberViewer.tiff" "TIFF Image"
    !insertmacro CV_WriteImageAssoc ".ico"  "CyberViewer.ico"  "Icon Image"

    WriteRegStr HKCU "Software\CyberViewer\Capabilities" "ApplicationName" "CyberViewer"
    WriteRegStr HKCU "Software\CyberViewer\Capabilities" "ApplicationDescription" "CyberViewer image viewer"
    WriteRegStr HKCU "Software\CyberViewer\Capabilities\FileAssociations" ".jpg" "CyberViewer.jpg"
    WriteRegStr HKCU "Software\CyberViewer\Capabilities\FileAssociations" ".jpeg" "CyberViewer.jpg"
    WriteRegStr HKCU "Software\CyberViewer\Capabilities\FileAssociations" ".png" "CyberViewer.png"
    WriteRegStr HKCU "Software\CyberViewer\Capabilities\FileAssociations" ".gif" "CyberViewer.gif"
    WriteRegStr HKCU "Software\CyberViewer\Capabilities\FileAssociations" ".webp" "CyberViewer.webp"
    WriteRegStr HKCU "Software\CyberViewer\Capabilities\FileAssociations" ".bmp" "CyberViewer.bmp"
    WriteRegStr HKCU "Software\CyberViewer\Capabilities\FileAssociations" ".tif" "CyberViewer.tiff"
    WriteRegStr HKCU "Software\CyberViewer\Capabilities\FileAssociations" ".tiff" "CyberViewer.tiff"
    WriteRegStr HKCU "Software\CyberViewer\Capabilities\FileAssociations" ".ico" "CyberViewer.ico"
    WriteRegStr HKCU "Software\RegisteredApplications" "CyberViewer" "Software\CyberViewer\Capabilities"

    System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
  ${EndIf}
!macroend

!macro customUnInstall
  ; Best-effort cleanup of per-user defaults we may have written
  DeleteRegKey HKCU "Software\Classes\CyberViewer.jpg"
  DeleteRegKey HKCU "Software\Classes\CyberViewer.png"
  DeleteRegKey HKCU "Software\Classes\CyberViewer.gif"
  DeleteRegKey HKCU "Software\Classes\CyberViewer.webp"
  DeleteRegKey HKCU "Software\Classes\CyberViewer.bmp"
  DeleteRegKey HKCU "Software\Classes\CyberViewer.tiff"
  DeleteRegKey HKCU "Software\Classes\CyberViewer.ico"
  DeleteRegKey HKCU "Software\CyberViewer"
  DeleteRegValue HKCU "Software\RegisteredApplications" "CyberViewer"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
