"""Протокол WebSocket /ws (версия 1).

Клиент -> сервер
  text   {"type":"hello", "v":1, "platform":"web", "scene":"outdoor", "hfov":65, "depth_scale":1.1}
         первое сообщение после подключения. depth_scale — сохранённая ручная калибровка.
  text   {"type":"config", "scene":"indoor", "hfov":70, "depth_scale":null}
         смена настроек на лету. depth_scale: null сбрасывает ручной масштаб этой сессии.
  text   {"type":"calibrate", "distance_m":2}
         следующий кадр: центр кадра считается находящимся на distance_m, масштаб фиксируется.
  text   {"type":"clear_calibration"}
         сброс ручного масштаба и угла обзора к значениям по умолчанию.
  binary [uint32 big-endian seq][JPEG]
         кадр. Клиент шлёт следующий кадр только после ответа на предыдущий.

Сервер -> клиент
  text   {"type":"ready", "v":1, "session":"…", "max_width":640}
  text   {"type":"result", "seq":42, "obstacles":[…], "server_ms":65.3, "dropped":0}
  text   {"type":"calibrated", "ok":true, "distance_m":2, "depth_scale":1.12, "hfov":68, "center_m":1.8, "message":"…"}
  text   {"type":"calibration_cleared"}
  text   {"type":"error", "message":"…"}
"""
import struct
from typing import Literal

from pydantic import BaseModel, Field

from .config import Scene
from .schemas import Obstacle

PROTOCOL_VERSION = 1
FRAME_HEADER = struct.Struct(">I")  # seq: uint32 big-endian
CLIENT_MAX_WIDTH = 640  # клиент ужимает кадр до этой ширины перед отправкой


class Hello(BaseModel):
    type: Literal["hello"]
    v: int = PROTOCOL_VERSION
    platform: str = "unknown"
    scene: Scene | None = None
    hfov: float | None = Field(default=None, gt=20, lt=150)
    depth_scale: float | None = Field(default=None, ge=0.25, le=4.0)


class Config(BaseModel):
    type: Literal["config"]
    scene: Scene | None = None
    hfov: float | None = Field(default=None, gt=20, lt=150)
    # null в JSON сбрасывает ручной масштаб; отсутствие поля его не трогает.
    depth_scale: float | None = Field(default=None, ge=0.25, le=4.0)


class Calibrate(BaseModel):
    type: Literal["calibrate"]
    distance_m: float = Field(gt=0.4, lt=20)


class ClearCalibration(BaseModel):
    type: Literal["clear_calibration"]


class Ready(BaseModel):
    type: Literal["ready"] = "ready"
    v: int = PROTOCOL_VERSION
    session: str
    max_width: int = CLIENT_MAX_WIDTH


class Result(BaseModel):
    type: Literal["result"] = "result"
    seq: int
    obstacles: list[Obstacle]
    server_ms: float
    dropped: int  # сколько кадров сервер выбросил как устаревшие (за сессию)


class Calibrated(BaseModel):
    type: Literal["calibrated"] = "calibrated"
    ok: bool
    distance_m: float
    depth_scale: float | None = None
    hfov: float | None = None
    center_m: float | None = None
    message: str


class CalibrationCleared(BaseModel):
    type: Literal["calibration_cleared"] = "calibration_cleared"


class Error(BaseModel):
    type: Literal["error"] = "error"
    message: str


def parse_frame(data: bytes) -> tuple[int, bytes]:
    if len(data) <= FRAME_HEADER.size:
        raise ValueError("кадр слишком короткий")
    (seq,) = FRAME_HEADER.unpack_from(data)
    return seq, data[FRAME_HEADER.size:]
