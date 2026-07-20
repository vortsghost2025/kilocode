export class Reporter {
  section(name: string, pass: boolean, detail: string) {
    console.log(`${name}: ${pass ? "PASS" : "FAIL"}`)
    console.log(detail || "none")
    console.log("")
  }

  summary(verdict: boolean, line: string) {
    console.log(`${line}: ${verdict ? "PASS" : "FAIL"}`)
  }
}
