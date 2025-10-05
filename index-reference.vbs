''v1.1 Changed Date functions with CDate and few bugs fixed
''v1.2 Change in Copy Paste format with values instead of All. Clearcontents of wsCon file instead of clear to keep date format in column A
''v1.3 Ucase strIndex for Equal Weight Index

Public wsInput As Worksheet, wsData As Worksheet, wsCon As Worksheet, wsTemp As Worksheet, wb As Workbook, wsA As Worksheet, wsIndDa As Worksheet, wsRat As Worksheet, wsTRI As Worksheet, wsVIX As Worksheet
    

Public Sub Setup()

    Set wb = ThisWorkbook
    With wb
        Set wsInput = .Sheets("Inp")
        Set wsTRI = .Sheets("Total Returns Index")
        Set wsTemp = .Sheets("Temp")
        'Set wsIndDa = .Sheets("Index Data")
        'Set wsRat = .Sheets("Ratio's")
        'Set wsVIX = Sheets("India VIX")
    End With
End Sub

Sub Download()
    strS = Timer
    Application.ScreenUpdating = False
    
    Call Setup
'    wsTemp.Visible = xlSheetVisible
    With wsInput
        strType = .Range("C5").Value
        strIndex = UCase(Replace(.Range("C6").Value, " ", "%20"))
        ' changed cell below...
        strFrmDate = CDate(.Range("C7").Value)
        strToDate = CDate(.Range("C8").Value)
        strNetDays = DateDiff("d", strFrmDate, strToDate)
    
        
        If strNetDays > 85 Then
            lngPart = Int(strNetDays / 84) + 1
        Else
            lngPart = 1
            strDynFrmDate = CDate(strFrmDate)
        End If
        Select Case strType
            Case "Index Data"
                strBaseURL = "URL;https://www.nseindia.com/products/dynaContent/equities/indices/historicalindices.jsp?indexType=" & strIndex & "&fromDate="
                strURL2 = ""
                Set wsCon = wsIndDa
                strFor = 0
'                strURL1 = strFrmDate & "&toDate=" & strToDate
            Case "P/E, P/B & Div Yield values"
                strBaseURL = "URL;https://www.nseindia.com/products/dynaContent/equities/indices/historical_pepb.jsp?indexName=" & strIndex & "&fromDate="
                strURL2 = "&yield1=undefined&yield2=undefined&yield3=undefined&yield4=all"
                Set wsCon = wsRat
                strFor = 0
            Case "Total Return Index"
                strBaseURL = "URL;https://www.nseindia.com/products/dynaContent/equities/indices/total_returnindices.jsp?indexType=" & strIndex & "&fromDate="
                strURL2 = ""
                Set wsCon = wsTRI
                strFor = 0
            Case "India VIX"
                strBaseURL = "URL;https://www.nseindia.com/products/dynaContent/equities/indices/hist_vix_data.jsp?&fromDate="
                strURL2 = ""
                Set wsCon = wsVIX
                strFor = 1
        End Select
        wsCon.Range("A4:D999999").ClearContents
        
'        strURL1
'        Sheets("Log").Cells.Clear
        For i = 1 To lngPart
            If i = lngPart Then
'                If DateDiff("d", strToDate, strDynToDate) < 0 Then
'                    Exit For
'                End If
                strDynToDate = CDate(strToDate)
                lRowCon = wsCon.Cells(wsCon.Rows.count, 1).End(xlUp).Row
            ElseIf i = 1 Then
                strDynFrmDate = CDate(strFrmDate)
                strDynToDate = DateAdd("d", 83, CDate(strDynFrmDate))
                lRowCon = 3
            Else
                strDynToDate = DateAdd("d", 83, CDate(strDynFrmDate))
                lRowCon = wsCon.Cells(wsCon.Rows.count, 1).End(xlUp).Row
            End If
            
            
'            Sheets("Log").Cells(i, 1).Value = FormatDate(strDynFrmDate, strFor)
'            Sheets("Log").Cells(i, 2).Value = FormatDate(strDynToDate, strFor)
'            Sheets("Log").Cells(i, 3).Value = DateDiff("d", strDynFrmDate, strDynToDate)
            
            
            wsTemp.Activate
            wsTemp.Cells.Clear
            
            
            strURL1 = FormatDate(strDynFrmDate, strFor) & "&toDate=" & FormatDate(strDynToDate, strFor)
            strURL = strBaseURL & strURL1 & strURL2
'            Debug.Print strURL
            Application.StatusBar = "Downloading " & Format((i / lngPart), "##0%")
             With wsTemp.QueryTables.Add(Connection:=strURL, Destination:=Range("$A$1"))
                .Name = "NIFTY1"""
                .FieldNames = True
                .RowNumbers = False
                .FillAdjacentFormulas = False
                .PreserveFormatting = True
                .RefreshOnFileOpen = False
                .BackgroundQuery = True
                .RefreshStyle = xlInsertDeleteCells
                .SavePassword = False
                .SaveData = True
                .AdjustColumnWidth = True
                .RefreshPeriod = 0
                .WebSelectionType = xlEntirePage
                .WebFormatting = xlNone
                .WebPreFormattedTextToColumns = False
                .WebConsecutiveDelimitersAsOne = True
                .WebSingleBlockTextImport = True
                .WebDisableDateRecognition = False
                .WebDisableRedirections = False
        '        .WebColumnDataTypes = Array(1, 1, 1, 1, 1, 1, 1)
                .Refresh BackgroundQuery:=False
            End With
            wsTemp.Activate
            lRowTemp = wsTemp.Cells(wsTemp.Rows.count, 1).End(xlUp).Row - 1
            wsTemp.Range("A6:J" & lRowTemp).Select
            Selection.Copy
            
            wsCon.Cells(lRowCon + 1, 1).PasteSpecial Paste:=xlPasteValues
            strDynFrmDate = CDate(DateAdd("d", 1, CDate(strDynToDate)))
            
        Next
        
    End With
'    wsTemp.Visible = xlSheetHidden
    lrowcons = wsCon.Cells(wsCon.Rows.count, 1).End(xlUp).Row
'    If InStr(wsCon.Cells(lrowcons, 1).Value, "Download") Then
'        wsCon.Cells(lrowcons, 1).Clear
'    End If
    'Application.ScreenUpdating = True
    If strFor = 1 Then
        wsCon.Range("A1").Value = FormatDate(strFrmDate, 1) & " To " & FormatDate(strToDate, 1)
    Else
        wsCon.Range("A1").Value = Replace(strIndex, "%20", " ") & " for " & FormatDate(strFrmDate, 1) & " To " & FormatDate(strToDate, 1)
    End If
    strT = Timer
    wsCon.Activate
    wsCon.Range("A1").Activate
    Application.StatusBar = "Completed in " & CInt(strT - strS) & " secs."
End Sub


Public Function FormatDate(strDate, boolFormat)
    If boolFormat = 0 Then
        FormatDate = Format(strDate, "dd-mm-yyyy")
    ElseIf boolFormat = 1 Then
        FormatDate = Format(strDate, "dd-mmm-yyyy")
    End If

End Function
