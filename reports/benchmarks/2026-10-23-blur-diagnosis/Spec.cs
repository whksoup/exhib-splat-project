using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

// 1D power spectrum (rows + columns, Hann window) of a square crop. Natural scenes follow
// P(f) ~ f^-b; the camera's optics / processing show as a fall below the power law fitted on
// the low band (0.02-0.08 cycles/px). Reports the deficit in dB at several frequencies, and
// f(-6dB) / f(-12dB): the first frequency where the spectrum is that far below the fit
// (0.5 = Nyquist; an image sharp to the pixel keeps close to the line up to ~0.3-0.4).
public static class Spec {
  static void Fft(double[] re, double[] im) {
    int n = re.Length;
    for (int i = 1, j = 0; i < n; i++) { int bit = n >> 1; for (; (j & bit) != 0; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { double t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (int len = 2; len <= n; len <<= 1) {
      double a = -2 * Math.PI / len; double wr = Math.Cos(a), wi = Math.Sin(a);
      for (int i = 0; i < n; i += len) { double cr = 1, ci = 0;
        for (int k = 0; k < len / 2; k++) { int p = i + k, q = p + len / 2;
          double xr = re[q] * cr - im[q] * ci, xi = re[q] * ci + im[q] * cr;
          re[q] = re[p] - xr; im[q] = im[p] - xi; re[p] += xr; im[p] += xi;
          double t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t; } }
    }
  }
  public static double[] Gray(string path, int cx, int cy, int n, out int w, out int h) {
    using (var bmp = new Bitmap(path)) {
      w = bmp.Width; h = bmp.Height;
      if (cx < 0) cx = w / 2; if (cy < 0) cy = h / 2;
      var d = bmp.LockBits(new Rectangle(cx - n / 2, cy - n / 2, n, n), ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
      var row = new byte[d.Stride]; var g = new double[n * n];
      for (int y = 0; y < n; y++) { Marshal.Copy(d.Scan0 + y * d.Stride, row, 0, d.Stride);
        for (int x = 0; x < n; x++) g[y * n + x] = 0.114 * row[3 * x] + 0.587 * row[3 * x + 1] + 0.299 * row[3 * x + 2]; }
      bmp.UnlockBits(d); return g;
    }
  }
  public static double[] Power(double[] g, int n) {
    var P = new double[n / 2 + 1]; var re = new double[n]; var im = new double[n];
    for (int pass = 0; pass < 2; pass++)
      for (int r = 0; r < n; r++) {
        double mean = 0; for (int i = 0; i < n; i++) mean += pass == 0 ? g[r * n + i] : g[i * n + r]; mean /= n;
        for (int i = 0; i < n; i++) { double v = (pass == 0 ? g[r * n + i] : g[i * n + r]) - mean; re[i] = v * (0.5 - 0.5 * Math.Cos(2 * Math.PI * i / (n - 1))); im[i] = 0; }
        Fft(re, im);
        for (int k = 0; k <= n / 2; k++) P[k] += re[k] * re[k] + im[k] * im[k];
      }
    return P;
  }
  public static string Probe(string path, int cx, int cy, int n) {
    int w, h; var P = Power(Gray(path, cx, cy, n, out w, out h), n);
    // Fit log P = a + b log f on 0.02..0.08 cycles/px.
    double sx = 0, sy = 0, sxx = 0, sxy = 0; int m = 0;
    for (int k = 1; k <= n / 2; k++) { double f = (double)k / n; if (f < 0.02 || f > 0.08) continue;
      double x = Math.Log(f), y = Math.Log(P[k]); sx += x; sy += y; sxx += x * x; sxy += x * y; m++; }
    double b = (m * sxy - sx * sy) / (m * sxx - sx * sx), a = (sy - b * sx) / m;
    Func<double, double> deficit = (f0) => { double s = 0; int c = 0;
      for (int k = 1; k <= n / 2; k++) { double f = (double)k / n; if (Math.Abs(f - f0) > 0.02) continue; s += P[k] / Math.Exp(a + b * Math.Log(f)); c++; }
      return 10 * Math.Log10(s / c); };
    Func<double, double> cross = (db) => { for (double f = 0.08; f <= 0.5; f += 0.005) if (deficit(f) < db) return f; return 0.5; };
    return String.Format("{0}x{1} slope={2:F2} d.15={3:F1} d.25={4:F1} d.35={5:F1} d.45={6:F1} f6={7:F3} f12={8:F3}",
      w, h, b, deficit(0.15), deficit(0.25), deficit(0.35), deficit(0.45), cross(-6), cross(-12));
  }
}
