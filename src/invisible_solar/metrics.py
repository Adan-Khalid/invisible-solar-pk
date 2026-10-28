"""Point and probabilistic forecast metrics."""
import numpy as np


def mape(y, yhat):
    y, yhat = np.asarray(y, float), np.asarray(yhat, float)
    m = y != 0
    return float(np.mean(np.abs((y[m] - yhat[m]) / y[m])) * 100)


def nrmse(y, yhat):
    y, yhat = np.asarray(y, float), np.asarray(yhat, float)
    return float(np.sqrt(np.mean((y - yhat) ** 2)) / np.mean(y) * 100)


def mae(y, yhat):
    return float(np.mean(np.abs(np.asarray(y, float) - np.asarray(yhat, float))))


def r2(y, yhat):
    y, yhat = np.asarray(y, float), np.asarray(yhat, float)
    return float(1 - np.sum((y - yhat) ** 2) / np.sum((y - y.mean()) ** 2))


def pinball(y, q_pred, q):
    """Average pinball loss for quantile q."""
    y, q_pred = np.asarray(y, float), np.asarray(q_pred, float)
    d = y - q_pred
    return float(np.mean(np.maximum(q * d, (q - 1) * d)))


def coverage(y, lo, hi):
    y = np.asarray(y, float)
    return float(np.mean((y >= np.asarray(lo)) & (y <= np.asarray(hi))) * 100)


def under_prediction_rate(y, yhat):
    """Share of hours where the forecast is below actual (operationally the costly direction)."""
    return float(np.mean(np.asarray(yhat, float) < np.asarray(y, float)) * 100)
