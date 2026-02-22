from __future__ import annotations

import argparse
import importlib
from pathlib import Path


def build_square_icon(
    input_path: Path, output_path: Path, alpha_threshold: int
) -> None:
    image_module = importlib.import_module("PIL.Image")

    image = image_module.open(input_path).convert("RGBA")
    alpha = image.getchannel("A")
    alpha_mask = alpha.point(lambda value: 255 if value >= alpha_threshold else 0)
    bbox = alpha_mask.getbbox()
    if bbox is None:
        raise ValueError(
            f"{input_path} has no visible pixels at alpha threshold {alpha_threshold}"
        )

    cropped = image.crop(bbox)
    width, height = cropped.size

    if width == height:
        result = cropped
    elif width > height:
        size = width
        result = image_module.new("RGBA", (size, size), (0, 0, 0, 0))
        result.paste(cropped, (0, size - height))
    else:
        size = height
        result = image_module.new("RGBA", (size, size), (0, 0, 0, 0))
        result.paste(cropped, (0, 0))

    output_path.parent.mkdir(parents=True, exist_ok=True)
    result.save(output_path)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Crop transparent edges and pad to square"
    )
    parser.add_argument("--input", type=Path, required=True, help="Input PNG path")
    parser.add_argument("--output", type=Path, required=True, help="Output PNG path")
    parser.add_argument(
        "--alpha-threshold",
        type=int,
        default=8,
        help="Alpha threshold used for trimming (0-255)",
    )
    args = parser.parse_args()

    if args.alpha_threshold < 0 or args.alpha_threshold > 255:
        raise ValueError("--alpha-threshold must be between 0 and 255")

    build_square_icon(args.input, args.output, args.alpha_threshold)
    print(f"Generated square icon: {args.output}")


if __name__ == "__main__":
    main()
