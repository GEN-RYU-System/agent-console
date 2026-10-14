import { describe, expect, it } from "vitest";
import { safeUploadName } from "../../server/uploadName.ts";

describe("safeUploadName (K3: design §3-3 table, every row)", () => {
  const rows: [string, string, string][] = [
    ["path traversal", "../../etc/x.csv", "x.csv"],
    ["backslash path", "a\\b.csv", "b.csv"],
    ["space", "売上 10月.csv", "売上_10月.csv"],
    ["symbols", "a\"b'c$d;e&f|g<h>i(j)k*l?m!n#o~p`q[r]s{t}u^v%w=x,y.csv", "a_b_c_d_e_f_g_h_i_j_k_l_m_n_o_p_q_r_s_t_u_v_w_x_y.csv"],
    ["two spaces", "a  b.csv", "a_b.csv"],
    ["leading dot", ".bashrc", "bashrc"],
    ["leading dash", "-rf.csv", "rf.csv"],
    ["leading dots", "..foo.csv", "foo.csv"],
    ["control char", "a\u0007b.txt", "a_b.txt"],
    ["NFD to NFC", "ダ.csv", "ダ.csv"],
    ["long body keeps extension", `${"a".repeat(200)}.csv`, `${"a".repeat(116)}.csv`],
    ["long without extension", "b".repeat(200), "b".repeat(120)],
    ["dots only", "...", "file"],
    ["slashes only", "///", "file"],
    ["quote only", '"', "file"],
    ["lone surrogate", "a\uD800b.csv", "a_b.csv"],
  ];
  for (const [label, input, expected] of rows) {
    it(label, () => {
      expect(safeUploadName(input)).toBe(expected);
    });
  }

  it("the long-body result is exactly 120 code points", () => {
    expect(Array.from(safeUploadName(`${"a".repeat(200)}.csv`))).toHaveLength(120);
  });
  it("counts code points, not UTF-16 units, when cutting (astral letters)", () => {
    const out = safeUploadName(`${"𠮷".repeat(150)}.csv`);
    expect(Array.from(out)).toHaveLength(120);
    expect(out.endsWith(".csv")).toBe(true);
  });
  it("never returns an empty name, a separator or a dot-only name", () => {
    for (const s of ["", ".", "..", "_", "/", "\\", "   ", "\u0000", "-", "--"]) {
      const out = safeUploadName(s);
      expect(out, JSON.stringify(s)).toBe("file");
    }
  });
});
