; Arkemis Office install and uninstall hooks, included by electron-builder's NSIS script (scripts/package-suite.mjs).
!include "FileFunc.nsh"
!include "WordFunc.nsh"

; ---- The apps (U:setup) -------------------------------------------------------------------------------------------
; Arkemis Office installs for everyone on the PC (Program Files, after Windows' administrator prompt) and sets itself up
; there in full. Each app gets its own Start menu entry in the all-users "Arkemis Office" folder (never the root, where
; another program may have its own Grid or Slate): the same program started with --product=<app>, with its own icon from
; resources\icons. Each app's file types are registered for the whole machine (HKLM\Software\Classes), with "Open with"
; entries, and Windows' Default apps lists Arkemis Office with all of them.
;
; Default program. A type that no working program opens becomes the app's: no program at all, or one left behind by an
; uninstalled program (a .xlsx on a PC without Excel gave "This file does not have an app associated with it", Nov 10).
; Windows only honours a machine-wide default for a type it never had a program for: the per-user default the 0.1.4 test
; build wrote made .docx open in Quill but left .xlsx and .one "Unknown". A type the person chose, or a working program
; has, is never taken.
;
; `/APPS=quill,grid,...` (an installer command-line option: the apps to set up) limits the entries to those apps; without it
; every app gets them. The per-user entries of the earlier per-user installs (0.1.0-0.1.4) are removed, and the uninstaller
; removes everything written here.

!macro OfficeAppEntry ID NAME
  ${If} $R9 == ""
  ${OrIf} $R9 == "*"
    StrCpy $R8 "1"
  ${Else}
    StrCpy $R8 "0"
    ClearErrors
    ${WordFind} ",$R9," ",${ID}," "E+1{" $R7
    IfErrors +2 0
      StrCpy $R8 "1"
  ${EndIf}
  ${If} $R8 == "1"
    CreateDirectory "$SMPROGRAMS\Arkemis Office"
    CreateShortCut "$SMPROGRAMS\Arkemis Office\${NAME}.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "--product=${ID}" "$INSTDIR\resources\icons\${ID}.ico" 0
    WriteRegStr HKLM "Software\Classes\Arkemis.${ID}" "" "${NAME}"
    WriteRegStr HKLM "Software\Classes\Arkemis.${ID}\DefaultIcon" "" "$INSTDIR\resources\icons\${ID}.ico,0"
    WriteRegStr HKLM "Software\Classes\Arkemis.${ID}\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --product=${ID} "%1"'
  ${EndIf}
!macroend

; $R4 = "1" when the program PROGID names can open a file: its default verb (or "open") has a command line, or it is a
; Store app (an AppX ProgID opens through its Application key). Uses $R2 and $R3.
!macro OfficeHandlerWorks PROGID
  StrCpy $R4 "0"
  ReadRegStr $R3 HKCR "${PROGID}\shell" ""
  ${If} $R3 == ""
    StrCpy $R3 "open"
  ${EndIf}
  ReadRegStr $R2 HKCR "${PROGID}\shell\$R3\command" ""
  ${If} $R2 == ""
    ReadRegStr $R2 HKCR "${PROGID}\shell\$R3\command" "DelegateExecute"
  ${EndIf}
  ${If} $R2 != ""
    StrCpy $R4 "1"
  ${EndIf}
  ClearErrors
  EnumRegKey $R2 HKCR "${PROGID}\Application" 0
  ${IfNot} ${Errors}
    StrCpy $R4 "1"
  ${EndIf}
  ClearErrors
!macroend

; The person's own choice (Windows' UserChoice, and UserChoiceLatest on newer Windows 11): kept when it works; removed when it
; names a program that is gone (Windows' choice protection may refuse that for some types; Windows then skips the dead choice
; and uses the default). Uses $R5 and $R6.
!macro OfficeChoice EXT KEY
  ReadRegStr $R5 HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\${EXT}\${KEY}" "ProgId"
  ${If} $R5 != ""
    !insertmacro OfficeHandlerWorks $R5
    ${If} $R4 == "1"
      StrCpy $R6 "0"
    ${Else}
      DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\${EXT}\${KEY}"
    ${EndIf}
  ${EndIf}
!macroend

; "Open with" references to programs that are gone: an uninstalled Office leaves ProgIDs with no command (Excel.Sheet.12,
; Excel.CSV) or none at all (OneNote.Section.1) listed for its types, and Windows then counts them as a second program and
; asks every time instead of using the default (.xlsx, .csv and .one stayed "Unknown" while .docx opened, Nov 10). Only
; references that open nothing are dropped; a working program's stay. KEY is a type's OpenWithProgids key. Uses $R1 and $R5.
!macro OfficeDropDead ROOT KEY
  StrCpy $R1 0
  ${Do}
    ClearErrors
    EnumRegValue $R5 ${ROOT} "${KEY}" $R1
    ${If} ${Errors}
    ${OrIf} $R5 == ""
      ${ExitDo}
    ${EndIf}
    !insertmacro OfficeHandlerWorks $R5
    ${If} $R4 == "1"
      IntOp $R1 $R1 + 1
    ${Else}
      DeleteRegValue ${ROOT} "${KEY}" $R5
    ${EndIf}
  ${Loop}
  ClearErrors
!macroend

!macro OfficeOpenWith ID EXT
  ${If} $R8 == "1"
    WriteRegStr HKLM "Software\Classes\${EXT}\OpenWithProgids" "Arkemis.${ID}" ""
    WriteRegStr HKLM "Software\ArkemisOffice\Capabilities\FileAssociations" "${EXT}" "Arkemis.${ID}"
    !insertmacro OfficeDropDead HKLM "Software\Classes\${EXT}\OpenWithProgids"
    !insertmacro OfficeDropDead HKCU "Software\Classes\${EXT}\OpenWithProgids"
    !insertmacro OfficeDropDead HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\${EXT}\OpenWithProgids"
    ; A per-user default that names a program that is gone hides the machine's: it goes.
    ReadRegStr $R5 HKCU "Software\Classes\${EXT}" ""
    ${If} $R5 != ""
      !insertmacro OfficeHandlerWorks $R5
      ${If} $R4 != "1"
        DeleteRegValue HKCU "Software\Classes\${EXT}" ""
      ${EndIf}
    ${EndIf}
    StrCpy $R6 "1"
    !insertmacro OfficeChoice "${EXT}" "UserChoice"
    !insertmacro OfficeChoice "${EXT}" "UserChoiceLatest"
    ${If} $R6 == "1"
      ReadRegStr $R5 HKCR "${EXT}" ""
      ${If} $R5 != ""
        !insertmacro OfficeHandlerWorks $R5
        ${If} $R4 == "1"
          StrCpy $R6 "0"
        ${EndIf}
      ${EndIf}
    ${EndIf}
    ${If} $R6 == "1"
      WriteRegStr HKLM "Software\Classes\${EXT}" "" "Arkemis.${ID}"
    ${EndIf}
  ${EndIf}
!macroend

; Removes an app's entries from one registry root: HKLM (this install) or HKCU (the per-user installs before 0.1.5).
!macro OfficeAppRemoveFrom ROOT ID NAME
  DeleteRegKey ${ROOT} "Software\Classes\Arkemis.${ID}"
!macroend

!macro OfficeAppRemove ID NAME
  Delete "$SMPROGRAMS\Arkemis Office\${NAME}.lnk"
  !insertmacro OfficeAppRemoveFrom HKLM ${ID} "${NAME}"
  !insertmacro OfficeAppRemoveFrom HKCU ${ID} "${NAME}"
!macroend

!macro OfficeOpenWithRemoveFrom ROOT ID EXT
  ReadRegStr $R5 ${ROOT} "Software\Classes\${EXT}" ""
  ${If} $R5 == "Arkemis.${ID}"
    DeleteRegValue ${ROOT} "Software\Classes\${EXT}" ""
  ${EndIf}
  DeleteRegValue ${ROOT} "Software\Classes\${EXT}\OpenWithProgids" "Arkemis.${ID}"
  DeleteRegKey /ifempty ${ROOT} "Software\Classes\${EXT}\OpenWithProgids"
  DeleteRegKey /ifempty ${ROOT} "Software\Classes\${EXT}"
!macroend

!macro OfficeOpenWithRemove ID EXT
  !insertmacro OfficeOpenWithRemoveFrom HKLM ${ID} "${EXT}"
  !insertmacro OfficeOpenWithRemoveFrom HKCU ${ID} "${EXT}"
!macroend

; Windows' Default apps lists Arkemis Office with every type it opens (Settings > Apps > Default apps > Arkemis Office), so the
; person can change any of them in one place.
!macro OfficeRegistered
  WriteRegStr HKLM "Software\ArkemisOffice\Capabilities" "ApplicationName" "Arkemis Office"
  WriteRegStr HKLM "Software\ArkemisOffice\Capabilities" "ApplicationDescription" "Documents, spreadsheets, presentations, notebooks and PDFs."
  WriteRegStr HKLM "Software\ArkemisOffice\Capabilities" "ApplicationIcon" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}",0'
  WriteRegStr HKLM "Software\RegisteredApplications" "Arkemis Office" "Software\ArkemisOffice\Capabilities"
!macroend

!macro OfficeRegisteredRemove
  DeleteRegValue HKLM "Software\RegisteredApplications" "Arkemis Office"
  DeleteRegKey HKLM "Software\ArkemisOffice"
  DeleteRegValue HKCU "Software\RegisteredApplications" "Arkemis Office"
  DeleteRegKey HKCU "Software\ArkemisOffice"
!macroend

; The names and file types, in one place for install and uninstall.
!macro OfficeApps STEP TYPES
  !insertmacro ${STEP} quill "Quill"
  !insertmacro ${TYPES} quill ".docx"
  !insertmacro ${TYPES} quill ".dotx"
  !insertmacro ${TYPES} quill ".doc"
  !insertmacro ${TYPES} quill ".rtf"
  !insertmacro ${TYPES} quill ".odt"
  !insertmacro ${STEP} grid "Grid"
  !insertmacro ${TYPES} grid ".xlsx"
  !insertmacro ${TYPES} grid ".xlsm"
  !insertmacro ${TYPES} grid ".xls"
  !insertmacro ${TYPES} grid ".csv"
  !insertmacro ${TYPES} grid ".ods"
  !insertmacro ${STEP} prism "Prism"
  !insertmacro ${TYPES} prism ".pptx"
  !insertmacro ${TYPES} prism ".ppsx"
  !insertmacro ${TYPES} prism ".ppt"
  !insertmacro ${TYPES} prism ".odp"
  !insertmacro ${STEP} slate "Slate"
  !insertmacro ${TYPES} slate ".one"
  !insertmacro ${STEP} folio "Arkemis PDF"
  !insertmacro ${TYPES} folio ".pdf"
!macroend

; The per-user Start menu folder of the installs before 0.1.5.
!macro OfficeOldUserShortcuts
  SetShellVarContext current
  RMDir /r "$SMPROGRAMS\Arkemis Office"
  SetShellVarContext all
!macroend

!macro customInstall
  Push $R0
  Push $R1
  Push $R2
  Push $R3
  Push $R4
  Push $R5
  Push $R6
  Push $R7
  Push $R8
  Push $R9
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/APPS=" $R9
  IfErrors 0 +2
    StrCpy $R9 ""
  !insertmacro OfficeOldUserShortcuts
  !insertmacro OfficeApps OfficeAppRemove OfficeOpenWithRemove
  !insertmacro OfficeRegisteredRemove
  !insertmacro OfficeApps OfficeAppEntry OfficeOpenWith
  !insertmacro OfficeRegistered
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
  Pop $R9
  Pop $R8
  Pop $R7
  Pop $R6
  Pop $R5
  Pop $R4
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
!macroend

; ---- Uninstall (security audit M5) --------------------------------------------------------------------------------
; electron-builder inserts customUnInstall into the uninstall section before it removes the installed files, so the
; app's own executable is still here to run. `--clear-trash` deletes only <app data>\Arkemis Studio\documents\trash
; (the closed documents' last working copies) and exits. It never touches the documents next to it, the person's own
; files, or anything else. An update runs the old uninstaller too: the trash is the person's 30-day undo, so it is
; kept then (the app entries are rewritten by the new install's customInstall).
!macro customUnInstall
  Push $R5
  !insertmacro OfficeApps OfficeAppRemove OfficeOpenWithRemove
  !insertmacro OfficeRegisteredRemove
  Pop $R5
  RMDir "$SMPROGRAMS\Arkemis Office"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
  ${ifNot} ${isUpdated}
    ${if} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
      DetailPrint "Clearing the trash of closed documents"
      ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --clear-trash'
    ${endif}
  ${endif}
!macroend
