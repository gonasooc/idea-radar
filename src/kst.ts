const dateFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Seoul',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

export function kstDate(d: Date): string {
  return dateFmt.format(d)
}

export function kstMonthKey(d: Date): string {
  return kstDate(d).slice(0, 7)
}
