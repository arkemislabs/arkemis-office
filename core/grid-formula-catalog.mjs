// Function descriptions adapted from GridCraft text.rs/date.rs (MIT); full notice in gridcraft-text-family.mjs.
export const gridFormulaCatalog=[
 {name:'SEQUENCE',family:'Math & Trig',signature:'SEQUENCE(rows, [columns], [start], [step])',description:'Spills evenly stepped numbers into a rectangle.',example:'=SEQUENCE(3,2,1,1)'},
 {name:'TRANSPOSE',family:'Lookup & Reference',signature:'TRANSPOSE(array)',description:'Swaps rows and columns without flattening the array.',example:'=TRANSPOSE(SEQUENCE(2,3))'},
 {name:'TEXTSPLIT',family:'Text',signature:'TEXTSPLIT(text, col_delimiter, [row_delimiter], [ignore_empty], [match_mode], [pad_with])',description:'Splits text into a rectangle of cells.',example:'=TEXTSPLIT("red,green;blue,gold",",",";")'},
 {name:'ARRAYTOTEXT',family:'Text',signature:'ARRAYTOTEXT(array, [format])',description:'Converts a shaped array to text, preserving row separators in strict mode.',example:'=ARRAYTOTEXT(SEQUENCE(2,3),1)'},
 {"name":"DAYS360","family":"Date and time","signature":"DAYS360(start_date, end_date, [method])","description":"Returns days between two dates using a 360-day year.","example":"=DAYS360(DATE(2026,1,1),DATE(2026,12,31))"},
  {
    "name": "CONCATENATE",
    "family": "Text",
    "signature": "CONCATENATE(text1, [text2], ...)",
    "description": "Joins several text values into one.",
    "example": "=CONCATENATE(\"Hello\",\" \",\"world\")"
  },
  {
    "name": "CONCAT",
    "family": "Text",
    "signature": "CONCAT(text1, [text2], ...)",
    "description": "Joins text from values and every cell of ranges, without a separator.",
    "example": "=CONCAT(\"Hello\",\" \",\"world\")"
  },
  {
    "name": "TEXTJOIN",
    "family": "Text",
    "signature": "TEXTJOIN(delimiter, ignore_empty, text1, [text2], ...)",
    "description": "Joins text from values and ranges with a delimiter, optionally skipping empty items.",
    "example": "=TEXTJOIN(\", \",1,\"red\",\"green\",\"blue\")"
  },
  {
    "name": "LEFT",
    "family": "Text",
    "signature": "LEFT(text, [num_chars])",
    "description": "Returns the first characters of a text.",
    "example": "=LEFT(\"Example\",3)"
  },
  {
    "name": "LEFTB",
    "family": "Text",
    "signature": "LEFTB(text, [num_bytes])",
    "description": "Byte version of LEFT (same as LEFT for single-byte text).",
    "example": "=LEFTB(\"Example\",3)"
  },
  {
    "name": "RIGHT",
    "family": "Text",
    "signature": "RIGHT(text, [num_chars])",
    "description": "Returns the last characters of a text.",
    "example": "=RIGHT(\"Example\",3)"
  },
  {
    "name": "RIGHTB",
    "family": "Text",
    "signature": "RIGHTB(text, [num_bytes])",
    "description": "Byte version of RIGHT (same as RIGHT for single-byte text).",
    "example": "=RIGHTB(\"Example\",3)"
  },
  {
    "name": "MID",
    "family": "Text",
    "signature": "MID(text, start_num, num_chars)",
    "description": "Returns characters from the middle of a text.",
    "example": "=MID(\"Example\",2,3)"
  },
  {
    "name": "MIDB",
    "family": "Text",
    "signature": "MIDB(text, start_num, num_bytes)",
    "description": "Byte version of MID (same as MID for single-byte text).",
    "example": "=MIDB(\"Example\",2,3)"
  },
  {
    "name": "LEN",
    "family": "Text",
    "signature": "LEN(text)",
    "description": "Counts the characters in a text.",
    "example": "=LEN(\"Example\")"
  },
  {
    "name": "LENB",
    "family": "Text",
    "signature": "LENB(text)",
    "description": "Byte version of LEN (same as LEN for single-byte text).",
    "example": "=LENB(\"Example\")"
  },
  {
    "name": "LOWER",
    "family": "Text",
    "signature": "LOWER(text)",
    "description": "Converts text to lower case.",
    "example": "=LOWER(\"Example\")"
  },
  {
    "name": "UPPER",
    "family": "Text",
    "signature": "UPPER(text)",
    "description": "Converts text to upper case.",
    "example": "=UPPER(\"Example\")"
  },
  {
    "name": "PROPER",
    "family": "Text",
    "signature": "PROPER(text)",
    "description": "Capitalises the first letter of each word and lower-cases the rest.",
    "example": "=PROPER(\"Example\")"
  },
  {
    "name": "TRIM",
    "family": "Text",
    "signature": "TRIM(text)",
    "description": "Removes leading and trailing spaces and collapses runs of spaces to one.",
    "example": "=TRIM(\"Example\")"
  },
  {
    "name": "CLEAN",
    "family": "Text",
    "signature": "CLEAN(text)",
    "description": "Removes non-printable control characters from text.",
    "example": "=CLEAN(\"Example\")"
  },
  {
    "name": "SUBSTITUTE",
    "family": "Text",
    "signature": "SUBSTITUTE(text, old_text, new_text, [instance_num])",
    "description": "Replaces occurrences of one text with another, optionally only a given occurrence.",
    "example": "=SUBSTITUTE(\"red apple\",\"red\",\"green\")"
  },
  {
    "name": "REPLACE",
    "family": "Text",
    "signature": "REPLACE(old_text, start_num, num_chars, new_text)",
    "description": "Replaces part of a text by position.",
    "example": "=REPLACE(\"abcdef\",2,3,\"XY\")"
  },
  {
    "name": "REPLACEB",
    "family": "Text",
    "signature": "REPLACEB(old_text, start_num, num_bytes, new_text)",
    "description": "Byte version of REPLACE.",
    "example": "=REPLACEB(\"abcdef\",2,3,\"XY\")"
  },
  {
    "name": "REPT",
    "family": "Text",
    "signature": "REPT(text, number_times)",
    "description": "Repeats a text a given number of times.",
    "example": "=REPT(\"ab\",3)"
  },
  {
    "name": "FIND",
    "family": "Text",
    "signature": "FIND(find_text, within_text, [start_num])",
    "description": "Finds the position of one text in another (case-sensitive).",
    "example": "=FIND(\"b\",\"abc\")"
  },
  {
    "name": "FINDB",
    "family": "Text",
    "signature": "FINDB(find_text, within_text, [start_num])",
    "description": "Byte version of FIND.",
    "example": "=FINDB(\"b\",\"abc\")"
  },
  {
    "name": "SEARCH",
    "family": "Text",
    "signature": "SEARCH(find_text, within_text, [start_num])",
    "description": "Finds the position of one text in another, ignoring case and allowing wildcards.",
    "example": "=SEARCH(\"B\",\"abc\")"
  },
  {
    "name": "SEARCHB",
    "family": "Text",
    "signature": "SEARCHB(find_text, within_text, [start_num])",
    "description": "Byte version of SEARCH.",
    "example": "=SEARCHB(\"B\",\"abc\")"
  },
  {
    "name": "EXACT",
    "family": "Text",
    "signature": "EXACT(text1, text2)",
    "description": "TRUE when two texts are identical, including case.",
    "example": "=EXACT(\"Apple\",\"apple\")"
  },
  {
    "name": "CHAR",
    "family": "Text",
    "signature": "CHAR(number)",
    "description": "Returns the character for a code from the Windows-1252 character set.",
    "example": "=CHAR(128)"
  },
  {
    "name": "CODE",
    "family": "Text",
    "signature": "CODE(text)",
    "description": "Returns the Windows-1252 code of the first character of a text.",
    "example": "=CODE(\"Example\")"
  },
  {
    "name": "UNICHAR",
    "family": "Text",
    "signature": "UNICHAR(number)",
    "description": "Returns the character for a Unicode code point.",
    "example": "=UNICHAR(9731)"
  },
  {
    "name": "UNICODE",
    "family": "Text",
    "signature": "UNICODE(text)",
    "description": "Returns the Unicode code point of the first character of a text.",
    "example": "=UNICODE(\"Example\")"
  },
  {
    "name": "VALUE",
    "family": "Text",
    "signature": "VALUE(text)",
    "description": "Converts text that looks like a number, date or time into a number.",
    "example": "=VALUE(\"$1,234.50\")"
  },
  {
    "name": "NUMBERVALUE",
    "family": "Text",
    "signature": "NUMBERVALUE(text, [decimal_separator], [group_separator])",
    "description": "Converts text to a number using the given decimal and group separators.",
    "example": "=NUMBERVALUE(\"2.500,27\",\",\",\".\")"
  },
  {
    "name": "FIXED",
    "family": "Text",
    "signature": "FIXED(number, [decimals], [no_commas])",
    "description": "Rounds a number and formats it as text with fixed decimals and optional thousands separators.",
    "example": "=FIXED(1234.567,2)"
  },
  {
    "name": "DOLLAR",
    "family": "Text",
    "signature": "DOLLAR(number, [decimals])",
    "description": "Formats a number as currency text.",
    "example": "=DOLLAR(1234.567,2)"
  },
  {
    "name": "USDOLLAR",
    "family": "Text",
    "signature": "USDOLLAR(number, [decimals])",
    "description": "Formats a number as currency text, like DOLLAR.",
    "example": "=USDOLLAR(1234.567,2)"
  },
  {
    "name": "BAHTTEXT",
    "family": "Text",
    "signature": "BAHTTEXT(number)",
    "description": "Spells out a number in Thai words with Baht.",
    "example": "=BAHTTEXT(1234.50)"
  },
  {
    "name": "T",
    "family": "Text",
    "signature": "T(value)",
    "description": "Returns the value if it is text, otherwise empty text.",
    "example": "=T(\"Example\")"
  },
  {
    "name": "TEXTBEFORE",
    "family": "Text",
    "signature": "TEXTBEFORE(text, delimiter, [instance_num], [match_mode], [match_end], [if_not_found])",
    "description": "Returns the text that comes before a delimiter.",
    "example": "=TEXTBEFORE(\"name@example.com\",\"@\")"
  },
  {
    "name": "TEXTAFTER",
    "family": "Text",
    "signature": "TEXTAFTER(text, delimiter, [instance_num], [match_mode], [match_end], [if_not_found])",
    "description": "Returns the text that comes after a delimiter.",
    "example": "=TEXTAFTER(\"name@example.com\",\"@\")"
  },
  {
    "name": "VALUETOTEXT",
    "family": "Text",
    "signature": "VALUETOTEXT(value, [format])",
    "description": "Converts any value to text, optionally in strict (quoted) form.",
    "example": "=VALUETOTEXT(\"Example\")"
  },
  {
    "name": "ASC",
    "family": "Text",
    "signature": "ASC(text)",
    "description": "Converts full-width characters to half-width (no change for single-byte text).",
    "example": "=ASC(\"Example\")"
  },
  {
    "name": "DBCS",
    "family": "Text",
    "signature": "DBCS(text)",
    "description": "Converts half-width characters to full-width (no change in this locale).",
    "example": "=DBCS(\"Example\")"
  },
  {
    "name": "JIS",
    "family": "Text",
    "signature": "JIS(text)",
    "description": "Converts half-width characters to full-width (no change in this locale).",
    "example": "=JIS(\"Example\")"
  },
  {
    "name": "PHONETIC",
    "family": "Text",
    "signature": "PHONETIC(reference)",
    "description": "Returns the phonetic (furigana) text; here the text itself.",
    "example": "=PHONETIC(\"Example\")"
  },
  {
    "name": "DATE",
    "family": "Date & Time",
    "signature": "DATE(year, month, day)",
    "description": "Builds a date serial number from a year, month and day.",
    "example": "=DATE(2026,10,7)"
  },
  {
    "name": "TIME",
    "family": "Date & Time",
    "signature": "TIME(hour, minute, second)",
    "description": "Builds a time (a fraction of a day) from hours, minutes and seconds.",
    "example": "=TIME(12,30,0)"
  },
  {
    "name": "YEAR",
    "family": "Date & Time",
    "signature": "YEAR(serial_number)",
    "description": "Returns the year of a date.",
    "example": "=YEAR(DATE(2026,10,7))"
  },
  {
    "name": "MONTH",
    "family": "Date & Time",
    "signature": "MONTH(serial_number)",
    "description": "Returns the month (1-12) of a date.",
    "example": "=MONTH(DATE(2026,10,7))"
  },
  {
    "name": "DAY",
    "family": "Date & Time",
    "signature": "DAY(serial_number)",
    "description": "Returns the day of the month of a date.",
    "example": "=DAY(DATE(2026,10,7))"
  },
  {
    "name": "HOUR",
    "family": "Date & Time",
    "signature": "HOUR(serial_number)",
    "description": "Returns the hour (0-23) of a time.",
    "example": "=HOUR(TIME(12,30,0))"
  },
  {
    "name": "MINUTE",
    "family": "Date & Time",
    "signature": "MINUTE(serial_number)",
    "description": "Returns the minute (0-59) of a time.",
    "example": "=MINUTE(TIME(12,30,0))"
  },
  {
    "name": "SECOND",
    "family": "Date & Time",
    "signature": "SECOND(serial_number)",
    "description": "Returns the second (0-59) of a time.",
    "example": "=SECOND(TIME(12,30,45))"
  },
  {
    "name": "NOW",
    "family": "Date & Time",
    "signature": "NOW()",
    "description": "Returns the current date and time.",
    "example": "=NOW()"
  },
  {
    "name": "TODAY",
    "family": "Date & Time",
    "signature": "TODAY()",
    "description": "Returns the current date.",
    "example": "=TODAY()"
  },
  {
    "name": "WEEKDAY",
    "family": "Date & Time",
    "signature": "WEEKDAY(serial_number, [return_type])",
    "description": "Returns the day of the week of a date as a number.",
    "example": "=WEEKDAY(DATE(2026,10,7),2)"
  },
  {
    "name": "WEEKNUM",
    "family": "Date & Time",
    "signature": "WEEKNUM(serial_number, [return_type])",
    "description": "Returns the week number of a date within its year.",
    "example": "=WEEKNUM(DATE(2026,10,7))"
  },
  {
    "name": "ISOWEEKNUM",
    "family": "Date & Time",
    "signature": "ISOWEEKNUM(date)",
    "description": "Returns the ISO 8601 week number of a date.",
    "example": "=ISOWEEKNUM(DATE(2026,10,7))"
  },
  {
    "name": "EDATE",
    "family": "Date & Time",
    "signature": "EDATE(start_date, months)",
    "description": "Returns the date a number of months before or after a date.",
    "example": "=EDATE(DATE(2026,1,31),1)"
  },
  {
    "name": "EOMONTH",
    "family": "Date & Time",
    "signature": "EOMONTH(start_date, months)",
    "description": "Returns the last day of the month a number of months away.",
    "example": "=EOMONTH(DATE(2026,1,1),1)"
  },
  {
    "name": "DATEDIF",
    "family": "Date & Time",
    "signature": "DATEDIF(start_date, end_date, unit)",
    "description": "Counts whole years, months or days between two dates. unit: Y, M, D, MD, YM or YD.",
    "example": "=DATEDIF(DATE(2025,1,1),DATE(2026,6,15),\"M\")"
  },
  {
    "name": "DATEVALUE",
    "family": "Date & Time",
    "signature": "DATEVALUE(date_text)",
    "description": "Converts a date written as text into a date serial number.",
    "example": "=DATEVALUE(\"2026-10-07\")"
  },
  {
    "name": "TIMEVALUE",
    "family": "Date & Time",
    "signature": "TIMEVALUE(time_text)",
    "description": "Converts a time written as text into a fraction of a day.",
    "example": "=TIMEVALUE(\"12:30 PM\")"
  },
  {
    "name": "DAYS",
    "family": "Date & Time",
    "signature": "DAYS(end_date, start_date)",
    "description": "Returns the number of days between two dates.",
    "example": "=DAYS(DATE(2026,10,7),DATE(2026,10,1))"
  },
  {
    "name": "NETWORKDAYS",
    "family": "Date & Time",
    "signature": "NETWORKDAYS(start_date, end_date, [holidays])",
    "description": "Counts working days (Monday to Friday) between two dates, excluding holidays.",
    "example": "=NETWORKDAYS(DATE(2026,10,1),DATE(2026,10,31))"
  },
  {
    "name": "NETWORKDAYS.INTL",
    "family": "Date & Time",
    "signature": "NETWORKDAYS.INTL(start_date, end_date, [weekend], [holidays])",
    "description": "Counts working days between two dates with a custom weekend, excluding holidays.",
    "example": "=NETWORKDAYS.INTL(DATE(2026,10,1),DATE(2026,10,31),\"0000011\")"
  },
  {
    "name": "WORKDAY",
    "family": "Date & Time",
    "signature": "WORKDAY(start_date, days, [holidays])",
    "description": "Returns the date a number of working days before or after a date.",
    "example": "=WORKDAY(DATE(2026,10,1),10)"
  },
  {
    "name": "WORKDAY.INTL",
    "family": "Date & Time",
    "signature": "WORKDAY.INTL(start_date, days, [weekend], [holidays])",
    "description": "Returns the date a number of working days away with a custom weekend.",
    "example": "=WORKDAY.INTL(DATE(2026,10,1),10,\"0000011\")"
  },
  {
    "name": "YEARFRAC",
    "family": "Date & Time",
    "signature": "YEARFRAC(start_date, end_date, [basis])",
    "description": "Returns the fraction of a year between two dates under a day-count basis.",
    "example": "=YEARFRAC(DATE(2026,1,1),DATE(2026,7,1),1)"
  }
];
