#!/usr/bin/env python
"""
生成测试基准数据（reference.json）

用 scipy 的 Cython 实现（_peak_finding_utils）作为峰值检测的权威参考，
用 openpyxl 直接读 Excel 作为解析的权威参考，供前端单元测试比对。

优先用 `scipy.signal.find_peaks`；如果本地 scipy 因为二进制问题没法整体导入
（某些 macOS 环境会这样），就退回直接加载 `_peak_finding_utils` 扩展模块。

依赖：numpy、openpyxl、scipy
用法：python3 scripts/gen-reference.py
"""
import glob
import importlib.util
import json
import os
import re
import statistics
import sys

import numpy as np
import openpyxl

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIXTURES = os.path.join(ROOT, "test", "fixtures")

pfu = None
try:  # 正常路径
    from scipy.signal import find_peaks as _scipy_find_peaks

    def scipy_find_peaks(x, distance=None, prominence=None):
        peaks, _ = _scipy_find_peaks(x, distance=distance, prominence=prominence)
        return [int(p) for p in peaks]

except Exception:  # noqa: BLE001 - 退回直接加载扩展模块
    import site
    import sysconfig

    roots = [sysconfig.get_paths().get("purelib", ""), sysconfig.get_paths().get("platlib", "")]
    for extra in (site.getsitepackages() if hasattr(site, "getsitepackages") else []):
        roots.append(extra)
    if hasattr(site, "getusersitepackages"):
        roots.append(site.getusersitepackages())

    so_candidates = []
    for root in filter(None, roots):
        so_candidates += glob.glob(os.path.join(root, "scipy", "signal", "_peak_finding_utils*.so"))
    if not so_candidates:
        sys.exit("找不到 scipy：请先 pip install scipy（或指定可用的 Python 环境）")
    spec = importlib.util.spec_from_file_location("_peak_finding_utils", so_candidates[0])
    pfu = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(pfu)

    def scipy_find_peaks(x, distance=None, prominence=None):
        x = np.asarray(x, dtype=np.float64)
        peaks = pfu._local_maxima_1d(x)[0]
        if prominence is not None and len(peaks):
            prom = pfu._peak_prominences(x, peaks, 0)[0]
            peaks = peaks[prom >= prominence]
        if distance is not None and len(peaks):
            keep = pfu._select_by_peak_distance(peaks, np.asarray(x, dtype=np.float64)[peaks], float(distance))
            peaks = peaks[keep]
        return [int(p) for p in peaks]


def read_xlsx(path):
    """返回 [(day, minutes, value)]，与前端 parser 的语义保持一致"""
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    ws = wb[wb.sheetnames[0]]
    rows = list(ws.iter_rows(values_only=True))
    wb.close()
    out = []
    for row in rows[1:]:
        if not row or row[0] is None:
            continue
        m = re.match(r"^(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})\s+(\d{1,2}):(\d{2})", str(row[0]).strip())
        if not m:
            continue
        day = "%s-%02d-%02d" % (m.group(1), int(m.group(2)), int(m.group(3)))
        minutes = int(m.group(4)) * 60 + int(m.group(5))
        out.append((day, minutes, float(row[1])))
    return out


def main():
    files = sorted(glob.glob(os.path.join(FIXTURES, "*.xlsx")))
    reference = {"files": {}, "peaks": []}

    for path in files:
        name = os.path.basename(path)
        rows = read_xlsx(path)
        days = {}
        for day, minutes, value in rows:
            days.setdefault(day, []).append((minutes, value))
        summary = {}
        for day, items in days.items():
            items.sort()
            values = [v for _, v in items]
            summary[day] = {
                "count": len(items),
                "first": items[0],
                "last": items[-1],
                "min": min(values),
                "max": max(values),
                "mean": round(statistics.fmean(values), 4),
            }
        reference["files"][name] = {"total": len(rows), "days": summary}

        # 峰值基准：多种参数组合
        for day, items in days.items():
            values = [v for _, v in items]
            if len(values) < 20:
                continue
            # 参数组合对应界面上能调出来的范围（prominence 最小 0.1）
            for distance_samples, prominence in [
                (6, 0.3),
                (12, 0.5),
                (1, 0.3),
                (3, 1.0),
                (6, 0.1),
                (2, 0.2),
                (24, 0.4),
                (6, 2.0),
            ]:
                key = f"d{distance_samples}_p{prominence}"
                peaks = scipy_find_peaks(values, distance=distance_samples, prominence=prominence)
                reference["peaks"].append(
                    {
                        "file": name,
                        "day": day,
                        "distance": distance_samples,
                        "prominence": prominence,
                        "indices": peaks,
                        "values": [round(values[i], 4) for i in peaks],
                    }
                )

    out_path = os.path.join(FIXTURES, "reference.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(reference, f, ensure_ascii=False)
    print(f"已生成 {out_path}")
    print(f"  文件数: {len(reference['files'])}，峰值用例数: {len(reference['peaks'])}")
    total_days = sum(len(v["days"]) for v in reference["files"].values())
    print(f"  天数合计: {total_days}")


if __name__ == "__main__":
    main()
